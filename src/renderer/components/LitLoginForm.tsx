import React, { useState } from 'react';

import { authService } from '../services/auth';
import { i18nService } from '../services/i18n';

interface LitLoginFormProps {
  onSuccess?: () => void;
}

/**
 * Username/password form logging into the literature backend (/lit/login).
 * Used by the welcome gate and the sidebar account button.
 */
const LitLoginForm: React.FC<LitLoginFormProps> = ({ onSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!username.trim() || !password) {
      setError(i18nService.t('litLoginMissingCredentials'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await authService.loginWithCredentials(username.trim(), password);
      if (result.success) {
        onSuccess?.();
      } else {
        setError(result.error || i18nService.t('litLoginFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('litLoginFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const inputClassName = 'block w-full h-10 rounded-xl bg-surface-inset border-border border '
    + 'focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 text-sm '
    + 'placeholder:text-muted outline-none transition-colors';

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <label className="block mb-1.5 text-xs font-medium text-secondary">
        {i18nService.t('litLoginUsername')}
      </label>
      <input
        type="text"
        value={username}
        onChange={(e) => { setUsername(e.target.value); }}
        autoComplete="username"
        spellCheck={false}
        placeholder={i18nService.t('litLoginUsernamePlaceholder')}
        className={inputClassName}
        disabled={submitting}
      />
      <label className="block mt-3 mb-1.5 text-xs font-medium text-secondary">
        {i18nService.t('litLoginPassword')}
      </label>
      <input
        type="password"
        value={password}
        onChange={(e) => { setPassword(e.target.value); }}
        autoComplete="current-password"
        placeholder={i18nService.t('litLoginPasswordPlaceholder')}
        className={inputClassName}
        disabled={submitting}
      />
      {error && (
        <p className="mt-2 text-xs text-red-500 break-words">{error}</p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="mt-4 w-full h-11 rounded-xl text-sm font-medium bg-foreground text-surface transition-opacity hover:opacity-90 active:opacity-80 outline-none disabled:opacity-50"
      >
        {submitting ? i18nService.t('litLoginSubmitting') : i18nService.t('litLoginSubmit')}
      </button>
    </form>
  );
};

export default LitLoginForm;
