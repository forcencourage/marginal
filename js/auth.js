import { supabase } from './supabaseClient.js';

const USER_KEY = 'marginal:userId';

export async function requireAuth() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      localStorage.setItem(USER_KEY, session.user.id);
      return session;
    }
  } catch {}

  // Offline with an expired token: supabase can't refresh it, but the user is
  // still the same person. Let them in on the cached identity.
  const cached = localStorage.getItem(USER_KEY);
  if (!navigator.onLine && cached) return { user: { id: cached }, offline: true };

  localStorage.removeItem(USER_KEY);
  window.location.href = 'login.html';
  return null;
}

export async function signOut() {
  await supabase.auth.signOut();
  localStorage.removeItem(USER_KEY);
  window.location.href = 'login.html';
}