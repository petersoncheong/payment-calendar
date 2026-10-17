// Cloud sync settings. Leave both empty to run in local-only mode (data stays on this device).
// Paste the values from Supabase → Project Settings → API. The anon/publishable key is designed to be public;
// your data is protected by the login + row-level security rules in supabase-setup.sql.
window.PAYMENT_CALENDAR_CONFIG = {
  supabaseUrl: 'https://zhlxtmcbksegwbhncpmu.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpobHh0bWNia3NlZ3diaG5jcG11Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyMzc1MTIsImV4cCI6MjEwNzgxMzUxMn0.3OLXxs8fqvpUGBO_Hq11slW8cdvxXWcyOYtjf6AnkTw',
  vapidPublicKey: 'BLmWSCb0uslxUWHz6cucUJ6IvB5jn3nwUEOxBtD_xtASW6grUNKGThk0yqG1rbcBU-bSefRpI9ZrYZ-qvZdzbfk'
};
