import { el, esc, clear, qs } from '../utils/dom.js';

export function renderSettings(container, api) {
  clear(container);
  container.appendChild(el('h2', { className: 'view-title' }, 'Settings'));

  let session = null;
  checkSession();

  async function checkSession() {
    // The sid cookie is HttpOnly, so the session probe endpoint is the
    // only way the SPA can learn whether it is signed in.
    try {
      const data = await api.me();
      session = data.user;
    } catch {
      session = null;
    }
    render();
  }

  function render() {
    clear(container);
    container.appendChild(el('h2', { className: 'view-title' }, 'Settings'));

    const authSection = el('section', { className: 'settings-section' });
    authSection.appendChild(el('h3', {}, 'Account'));

    if (session) {
      authSection.appendChild(renderAuthStatus(api, session, () => checkSession()));
    } else {
      authSection.appendChild(renderAuthForm(api, () => checkSession()));
    }
    container.appendChild(authSection);

    const prefsSection = el('section', { className: 'settings-section' });
    prefsSection.appendChild(el('h3', {}, 'Store Preferences (coming soon)'));
    prefsSection.appendChild(el('p', { className: 'quiet' }, 'Select and rank your preferred stores for personalised deals.'));
    container.appendChild(prefsSection);

    const aboutSection = el('section', { className: 'settings-section' });
    aboutSection.appendChild(el('h3', {}, 'About'));
    aboutSection.appendChild(el('p', { className: 'quiet' }, 'price\u00b7minder \u2014 New Zealand grocery price intelligence. Collects prices from major NZ grocery retailers.'));
    container.appendChild(aboutSection);
  }
}

function renderAuthForm(api, onSuccess) {
  const wrap = el('div', { className: 'auth-form-wrap' });
  const tabs = el('div', { className: 'auth-tabs' });
  let mode = 'login';

  const loginTab = el('button', { className: 'auth-tab active', onClick: () => { mode = 'login'; update(); } }, 'Sign In');
  const registerTab = el('button', { className: 'auth-tab', onClick: () => { mode = 'register'; update(); } }, 'Create Account');
  tabs.appendChild(loginTab);
  tabs.appendChild(registerTab);
  wrap.appendChild(tabs);

  const form = el('form', { className: 'auth-form', onSubmit: handleSubmit });
  const errorEl = el('div', { className: 'auth-error hide' });
  form.appendChild(errorEl);

  const usernameField = el('div', { className: 'auth-field' });
  usernameField.appendChild(el('label', { htmlFor: 'auth-username' }, 'Username'));
  usernameField.appendChild(el('input', { id: 'auth-username', name: 'username', required: true, minlength: '2', maxlength: '50' }));
  form.appendChild(usernameField);

  const passwordField = el('div', { className: 'auth-field' });
  passwordField.appendChild(el('label', { htmlFor: 'auth-password' }, 'Password'));
  passwordField.appendChild(el('input', { id: 'auth-password', name: 'password', type: 'password', required: true, minlength: '4', maxlength: '200' }));
  form.appendChild(passwordField);

  const submitBtn = el('button', { type: 'submit', className: 'btn btn-primary' }, 'Sign In');
  form.appendChild(submitBtn);
  wrap.appendChild(form);

  function update() {
    loginTab.className = `auth-tab ${mode === 'login' ? 'active' : ''}`;
    registerTab.className = `auth-tab ${mode === 'register' ? 'active' : ''}`;
    submitBtn.textContent = mode === 'login' ? 'Sign In' : 'Create Account';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username || !password) return;

    errorEl.classList.add('hide');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Please wait\u2026';

    try {
      if (mode === 'login') {
        await api.login({ username, password });
      } else {
        await api.register({ username, password });
        await api.login({ username, password });
      }
      onSuccess();
    } catch (err) {
      errorEl.textContent = err.data?.error || 'Invalid credentials';
      errorEl.classList.remove('hide');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = mode === 'login' ? 'Sign In' : 'Create Account';
    }
  }

  return wrap;
}

function renderAuthStatus(api, session, onLogout) {
  const wrap = el('div', { className: 'auth-status' });
  wrap.appendChild(el('p', {}, `Signed in as ${session.username}`));
  const logoutBtn = el('button', {
    className: 'btn btn-outline',
    onClick: async () => {
      try { await api.logout(); } catch {}
      onLogout();
    }
  }, 'Sign Out');
  wrap.appendChild(logoutBtn);
  return wrap;
}
