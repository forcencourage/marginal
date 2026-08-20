import { supabase } from './supabaseClient.js';

const form = document.getElementById('login-form');
const emailInput = document.getElementById('login-email');
const passwordInput = document.getElementById('login-password');
const errorEl = document.getElementById('login-error');
const submitBtn = document.getElementById('login-submit');

init();

async function init() {
  // Already signed in? skip straight to the library.
  const { data: { session } } = await supabase.auth.getSession();
  if (session) window.location.href = 'index.html';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in…';

  const { error } = await supabase.auth.signInWithPassword({
    email: emailInput.value.trim(),
    password: passwordInput.value,
  });

  if (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in';
    return;
  }

  window.location.href = 'index.html';
});