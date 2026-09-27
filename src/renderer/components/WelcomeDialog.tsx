import React from 'react';

import { i18nService } from '@/services/i18n';

import LitLoginForm from './LitLoginForm';

const SERVICE_TERMS_URL = 'https://c.youdao.com/dict/hardware/lobsterai/lobsterai_service.html';

// Ripple rings radiating from the logo: diameter and opacity per ring.
const LOGO_RINGS: Array<{ size: number; opacity: number }> = [
  { size: 150, opacity: 0.55 },
  { size: 255, opacity: 0.4 },
  { size: 380, opacity: 0.28 },
  { size: 560, opacity: 0.16 },
];

interface WelcomeDialogProps {
  onLogin: () => void;
  loginPending: boolean;
  onCancelLogin: () => void;
}

// Full-page login gate: on first launch it doubles as the terms-consent
// screen (continuing via login counts as accepting the service agreement);
// afterwards it shows whenever the user is logged out.
const WelcomeDialog: React.FC<WelcomeDialogProps> = ({
  onLogin,
  loginPending,
  onCancelLogin,
}) => {
  const handleTermsClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    await window.electron.shell.openExternal(SERVICE_TERMS_URL);
  };

  const notice = i18nService.t('welcomeAgreementNotice');
  const linkText = i18nService.t('welcomeAgreementLinkText');
  const [noticeBefore, noticeAfter] = notice.split('{link}');
  const copyright = i18nService
    .t('welcomeCopyright')
    .replace('{year}', String(new Date().getFullYear()));

  return (
    <div className="fixed inset-0 z-[60] bg-surface flex flex-col items-center overflow-hidden">
      {/* ambient brand glows: warm top-left echoing the logo, cool bottom-right echoing primary */}
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(640px 420px at 12% -6%, rgba(255, 77, 46, 0.07), transparent 70%), '
            + 'radial-gradient(720px 480px at 88% 106%, rgba(59, 130, 246, 0.06), transparent 70%)',
        }}
      />

      {/* main content */}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center w-[320px]">
        {/* logo with ripple rings radiating from it, fading out before the text below */}
        <div className="relative mb-6">
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
            style={{
              width: 560,
              height: 560,
              maskImage: 'linear-gradient(to bottom, black 50%, transparent 76%)',
              WebkitMaskImage: 'linear-gradient(to bottom, black 50%, transparent 76%)',
            }}
          >
            {LOGO_RINGS.map(({ size, opacity }) => (
              <div
                key={size}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border"
                style={{ width: size, height: size, opacity }}
              />
            ))}
          </div>
          <img
            src="logo.png"
            alt="LobsterAI"
            width={72}
            height={72}
            className="relative rounded-2xl select-none"
            draggable={false}
          />
        </div>

        <h1 className="text-2xl font-semibold text-foreground mb-8 text-center">
          {i18nService.t('welcomeTitle')}
        </h1>

        {/* actions area keeps a stable height across the idle and login-pending states */}
        <div className="flex min-h-[140px] w-full flex-col items-center">
          {loginPending ? (
            <>
              {/* credentials form against the literature backend; the gate stays until auth lands */}
              <div className="w-full">
                <div className="mb-4 text-sm font-medium text-foreground text-center">
                  {i18nService.t('litLoginTitle')}
                </div>
                <LitLoginForm />
              </div>
              <button
                onClick={onCancelLogin}
                className="mt-3 text-sm text-secondary hover:text-foreground underline underline-offset-2 outline-none"
              >
                {i18nService.t('back')}
              </button>
            </>
          ) : (
            <>
              {/* primary: login */}
              <button
                onClick={onLogin}
                className="w-full h-11 rounded-xl text-sm font-medium bg-foreground text-surface transition-opacity hover:opacity-90 active:opacity-80 outline-none"
              >
                {i18nService.t('welcomeLogin')}
              </button>
            </>
          )}
        </div>
      </div>

      {/* footer: consent notice + copyright */}
      <div className="relative z-10 flex flex-col items-center gap-1 pb-8 px-8 text-center">
        <p className="text-xs text-secondary leading-relaxed">
          {noticeBefore}
          <a
            href={SERVICE_TERMS_URL}
            onClick={handleTermsClick}
            className="underline underline-offset-2 hover:text-foreground outline-none"
          >
            {linkText}
          </a>
          {noticeAfter}
        </p>
        <p className="text-xs text-secondary/70">{copyright}</p>
      </div>
    </div>
  );
};

export default WelcomeDialog;
