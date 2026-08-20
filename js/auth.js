import { supabase } from './supabaseClient.js';

// Call at the top of any page that requires a signed-in user.
// Redirects to login.html and returns null if there's no session.
export async function requireAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }
  return session;
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = 'login.html';
}