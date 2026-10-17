// Supabase Edge Function: send-due-alerts
// Runs every hour (pg_cron → this function). For every subscribed device whose local time is its chosen alert hour,
// it sends one push notification summarising the payments due that local day. Also handles the app's "Send test" button.
//
// Secrets required (Edge Functions → Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

// ---- pure helpers (unit-tested locally) ----
export function localParts(timeZone: string, at: Date = new Date()): { date: string; hour: number } {
  let parts: Intl.DateTimeFormatPart[];
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' } as const;
  try { parts = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone }).formatToParts(at); }
  catch { parts = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'UTC' }).formatToParts(at); }
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

export function money(n: number, currency: string): string {
  return currency + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export type Due = { invoice: string; amount: number | string; payees: { name: string } | { name: string }[] | null };

export function buildMessage(rows: Due[], currency: string, isTest: boolean): { title: string; body: string; tag: string } {
  if (!rows.length) return { title: 'Alerts are working ✓', body: 'No payments are due today.', tag: 'due-today' };
  const per = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const p = Array.isArray(r.payees) ? r.payees[0] : r.payees;
    const name = p?.name ?? 'Unknown payee';
    const amt = Number(r.amount);
    per.set(name, (per.get(name) ?? 0) + amt);
    total += amt;
  }
  const sorted = [...per.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, 3).map(([n, a]) => `${n} ${money(a, currency)}`).join(' · ');
  const more = sorted.length > 3 ? ` · +${sorted.length - 3} more` : '';
  const n = rows.length;
  return {
    title: `${isTest ? 'Test: ' : ''}${n} payment${n === 1 ? '' : 's'} due today · ${money(total, currency)}`,
    body: shown + more,
    tag: 'due-today',
  };
}
// ---- end helpers ----

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...cors } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try { return await handle(req); }
  catch (e) { console.error('unhandled', e); return json({ error: `server error: ${(e as Error).message}` }, 500); }
});

async function handle(req: Request): Promise<Response> {
  // Report setup problems by name (never by value) so they're easy to fix.
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'CRON_SECRET']
    .filter(k => !Deno.env.get(k));
  if (missing.length) return json({ error: `missing secrets: ${missing.join(', ')}` }, 500);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  try {
    webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT')!, Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!);
  } catch (e) { return json({ error: `VAPID setup failed: ${(e as Error).message}` }, 500); }

  const body = await req.json().catch(() => ({}));
  const cronSecret = Deno.env.get('CRON_SECRET');
  const isCron = !!cronSecret && req.headers.get('x-cron-secret') === cronSecret;

  let query = admin.from('push_subscriptions').select('*');
  let testUser: string | null = null;
  if (!isCron) {
    // Not the scheduler: only a signed-in user asking for a test to their own device(s).
    if (!body.test) return json({ error: 'unauthorized' }, 401);
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return json({ error: 'not signed in' }, 401);
    testUser = data.user.id;
    query = query.eq('user_id', testUser);
    if (body.endpoint) query = query.eq('endpoint', String(body.endpoint));
  }

  const { data: subs, error: subsErr } = await query;
  if (subsErr) return json({ error: subsErr.message }, 500);

  let sent = 0, removed = 0, failed = 0, skipped = 0;
  for (const s of subs ?? []) {
    const { date, hour } = localParts(s.timezone);
    if (!testUser && (hour !== s.notify_hour || s.last_sent_on === date)) { skipped++; continue; }

    const { data: rows, error } = await admin.from('payments')
      .select('invoice, amount, payees(name)')
      .eq('user_id', s.user_id).eq('pay_date', date);
    if (error) { failed++; console.error('query failed', error.message); continue; }
    if (!testUser && !rows?.length) { skipped++; continue; }          // nothing due → stay quiet

    const msg = buildMessage((rows ?? []) as Due[], s.currency ?? '$', !!testUser);
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(msg),
        { TTL: 6 * 3600, urgency: 'normal' },
      );
      sent++;
      if (!testUser) await admin.from('push_subscriptions').update({ last_sent_on: date }).eq('id', s.id);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) { await admin.from('push_subscriptions').delete().eq('id', s.id); removed++; }   // device unsubscribed
      else { failed++; console.error('push failed', code, (e as Error).message); }
    }
  }
  return json({ ok: true, sent, removed, failed, skipped, devices: subs?.length ?? 0 });
}
