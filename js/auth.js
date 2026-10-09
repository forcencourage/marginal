import { supabase, isOnline, connectivityReady } from './supabaseClient.js';

const USER_KEY = 'marginal:userId';

export async function requireAuth() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      localStorage.setItem(USER_KEY, session.user.id);
      return session;
    }
  } catch {}

  await connectivityReady;
  const cached = localStorage.getItem(USER_KEY);
  if (!isOnline() && cached) return { user: { id: cached }, offline: true };

  localStorage.removeItem(USER_KEY);
  window.location.href = 'login.html';
  return null;
}

export async function signOut() {
  await supabase.auth.signOut();
  localStorage.removeItem(USER_KEY);
  window.location.href = 'login.html';
}