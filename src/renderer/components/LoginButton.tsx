import { ChevronRightIcon } from '@heroicons/react/24/outline';
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSelector } from 'react-redux';

import inviteCreditsIconUrl from '../assets/icons/invite-credits.svg';
import logoutIconUrl from '../assets/icons/logout.svg';
import promoSubscriptionIconUrl from '../assets/icons/promo-subscription.svg';
import rechargeIconUrl from '../assets/icons/recharge.svg';
import soccerBallIconUrl from '../assets/icons/soccer-ball.svg';
import usageOverviewIconUrl from '../assets/icons/usage-overview.svg';
import { EnterpriseAccountMenu } from '../features/enterpriseAccount/components/EnterpriseAccountMenu';
import { selectEnterpriseAccountContext } from '../features/enterpriseAccount/selectors';
import { authService } from '../services/auth';
import {
  getPortalCreditsDetailUrl,
  getPortalCreditsResetActivityUrl,
  getPortalInvitationUrl,
  getPortalProfileUrl,
  getPortalRechargeUrl,
} from '../services/endpoints';
import { i18nService } from '../services/i18n';
import { LogReporterAction, reportYdAnalyzer } from '../services/logReporter';
import { RootState } from '../store';
import type { FreeCreditsReward } from '../store/slices/authSlice';
import {
  getAccountPlanPresentation,
  getFinalRewards,
} from './accountMenuState';
import CreditsFinalRewardModal from './CreditsFinalRewardModal';
import UserAvatarIcon from './icons/UserAvatarIcon';
import LitLoginForm from './LitLoginForm';

const ACCOUNT_MENU_ANALYTICS_SOURCE = 'home_account_menu';

const reportAccountMenuAction = (
  actionType: string,
  options: {
    creditItemCount?: number;
    hasCredits?: boolean;
    isLoggedIn?: boolean;
    result?: 'success' | 'failed';
  } = {},
): void => {
  console.debug('[LoginButton] reporting account menu analytics');
  void reportYdAnalyzer({
    action: LogReporterAction.AccountMenuAction,
    source: ACCOUNT_MENU_ANALYTICS_SOURCE,
    actionType,
    result: options.result,
    isLoggedIn: options.isLoggedIn ?? true,
    hasCredits: options.hasCredits,
    creditItemCount: options.creditItemCount,
  });
};

const formatDate = (dateStr: string | null): string => {
  if (!dateStr) return '';
  // Format "2026-03-29" to "26.03.29"
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[0].slice(2)}.${parts[1]}.${parts[2]}`;
};

const formatCredits = (n: number): string => {
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2);
};

const getFinalRewardText = (reward: FreeCreditsReward | undefined) => {
  const creditsText = reward ? formatCredits(reward.credits) : '0';
  const isEn = i18nService.getLanguage() === 'en';
  const presentation = reward?.presentation;
  return {
    creditsText,
    title: (isEn ? presentation?.titleEn : presentation?.titleZh)
      || i18nService.t('authFinalRewardAlt').replace('{credits}', creditsText),
    actionText: (isEn ? presentation?.actionTextEn : presentation?.actionTextZh)
      || i18nService.t('authFinalRewardAction').replace('{credits}', creditsText),
  };
};

interface AccountMenuActionProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void | Promise<void>;
  trailing?: React.ReactNode;
  danger?: boolean;
}

const AccountMenuAction: React.FC<AccountMenuActionProps> = ({
  icon,
  label,
  onClick,
  trailing,
  danger = false,
}) => (
  <button
    type="button"
    onClick={() => void onClick()}
    className={`flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-[13px] transition-colors hover:bg-surface-raised ${
      danger ? 'text-red-500' : 'text-foreground'
    }`}
  >
    {icon}
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {trailing}
  </button>
);

const PortalMenuIcon: React.FC<{ src: string; darkInvert?: boolean }> = ({
  src,
  darkInvert = false,
}) => (
  <img
    src={src}
    alt=""
    className={`h-4 w-4 shrink-0 ${darkInvert ? 'dark:invert' : ''}`}
    aria-hidden="true"
  />
);

const PointsStackIcon: React.FC = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="3 3 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    className="h-4 w-4 shrink-0 text-[#111111] dark:text-white"
    aria-hidden="true"
  >
    <ellipse cx="12" cy="7.75" rx="5.75" ry="2.5" />
    <path d="M6.25 7.75V12.25C6.25 13.63 8.82 14.75 12 14.75C15.18 14.75 17.75 13.63 17.75 12.25V7.75" />
    <path d="M6.25 12.25V16.25C6.25 17.63 8.82 18.75 12 18.75C15.18 18.75 17.75 17.63 17.75 16.25V12.25" />
  </svg>
);

interface UserMenuProps {
  onClose: () => void;
  onOpenFinalReward: (campaignCode: string) => void;
}

const UserMenu: React.FC<UserMenuProps> = ({
  onClose,
  onOpenFinalReward,
}) => {
  const user = useSelector((state: RootState) => state.auth.user);
  const profileSummary = useSelector((state: RootState) => state.auth.profileSummary);
  const isEn = i18nService.getLanguage() === 'en';

  useEffect(() => {
    authService.fetchProfileSummary();
  }, []);

  const openPortalUrl = async (url: string) => {
    await window.electron.shell.openExternal(url);
    onClose();
  };

  const handleLogout = async () => {
    try {
      await authService.logout();
      reportAccountMenuAction('logout', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'success',
      });
      onClose();
    } catch (error) {
      reportAccountMenuAction('logout', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'failed',
      });
      throw error;
    }
  };

  const handleCreditsDetail = async () => {
    try {
      await openPortalUrl(getPortalCreditsDetailUrl());
      reportAccountMenuAction('open_credits_detail', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'success',
      });
    } catch (error) {
      reportAccountMenuAction('open_credits_detail', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'failed',
      });
      throw error;
    }
  };

  const handleUsageOverview = async () => {
    try {
      await openPortalUrl(getPortalProfileUrl());
      reportAccountMenuAction('open_usage_overview', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'success',
      });
    } catch (error) {
      reportAccountMenuAction('open_usage_overview', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'failed',
      });
      throw error;
    }
  };

  const handleRecharge = async () => {
    try {
      await openPortalUrl(getPortalRechargeUrl());
      reportAccountMenuAction('open_recharge', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'success',
      });
    } catch (error) {
      reportAccountMenuAction('open_recharge', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'failed',
      });
      throw error;
    }
  };

  const handleInvite = async () => {
    try {
      await openPortalUrl(getPortalInvitationUrl());
      reportAccountMenuAction('open_invitation', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'success',
      });
    } catch (error) {
      reportAccountMenuAction('open_invitation', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'failed',
      });
      throw error;
    }
  };

  const handleCreditsResetActivity = async () => {
    try {
      await openPortalUrl(getPortalCreditsResetActivityUrl());
      reportAccountMenuAction('open_credits_reset_campaign', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'success',
      });
    } catch (error) {
      reportAccountMenuAction('open_credits_reset_campaign', {
        creditItemCount: creditItems.length,
        hasCredits,
        result: 'failed',
      });
      throw error;
    }
  };

  const handleFinalReward = (reward: FreeCreditsReward) => {
    reportAccountMenuAction('open_credits_final_reward', {
      creditItemCount: creditItems.length,
      hasCredits,
      result: 'success',
    });
    onClose();
    onOpenFinalReward(reward.campaignCode);
  };

  const phoneSuffix = user?.phone ? user.phone.slice(-4) : '';

  const totalCredits = profileSummary?.totalCreditsRemaining ?? 0;
  const creditItems = profileSummary?.creditItems ?? [];
  const hasCredits = creditItems.length > 0;
  const accountName = profileSummary?.nickname
    || user?.nickname
    || (phoneSuffix ? `****${phoneSuffix}` : i18nService.t('myAccount'));
  const accountPlan = getAccountPlanPresentation(creditItems, isEn);
  const availableResetCount = profileSummary?.availableResetCount ?? 0;
  const availablePromoSubscriptionCount = profileSummary?.availablePromoSubscriptionCount ?? 0;
  const campaignActionLabel = availableResetCount > 0
    ? i18nService.t('authCreditsResetActionCount').replace('{count}', String(availableResetCount))
    : availablePromoSubscriptionCount > 0
      ? i18nService.t('authPromoSubscriptionAction')
      : null;
  const finalRewards = getFinalRewards(profileSummary?.creditsResetCampaign);

  return (
    <div className="absolute bottom-full left-[-0.5rem] z-50 mb-1 max-h-[calc(100vh-4rem)] w-[14.5rem] overflow-y-auto rounded-xl border border-border bg-surface shadow-popover popover-enter">
      {/* Account info */}
      <div className="border-b border-border px-4 py-3">
        <div className="truncate text-sm font-medium text-foreground">
          {accountName}
        </div>
        {accountPlan && (
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            <span className="inline-flex max-w-[112px] shrink-0 items-center truncate rounded bg-[#EDF4FF] px-1.5 py-0.5 text-[10px] font-medium leading-none text-[#4D73E8] dark:bg-[#26334F] dark:text-[#9CB5FF]">
              {accountPlan.label}
            </span>
            {accountPlan.expiresAt && (
              <span className="truncate text-[10px] text-secondary">
                {i18nService.t('authPlanExpiresAt').replace(
                  '{date}',
                  formatDate(accountPlan.expiresAt),
                )}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Account destinations */}
      <div className="border-b border-border py-1">
        <AccountMenuAction
          icon={<PointsStackIcon />}
          label={i18nService.t('authCreditsRemaining')}
          trailing={(
            <span className="ml-auto flex shrink-0 items-center gap-1 text-xs font-medium text-foreground">
              {formatCredits(totalCredits)}
              <ChevronRightIcon className="h-3.5 w-3.5 text-secondary" />
            </span>
          )}
          onClick={handleCreditsDetail}
        />
        <AccountMenuAction
          icon={<PortalMenuIcon src={usageOverviewIconUrl} darkInvert />}
          label={i18nService.t('authUsageOverview')}
          onClick={handleUsageOverview}
        />
        <AccountMenuAction
          icon={<PortalMenuIcon src={rechargeIconUrl} darkInvert />}
          label={i18nService.t('authGoRecharge')}
          onClick={handleRecharge}
        />
      </div>

      {/* Campaigns and invitations */}
      <div className="border-b border-border py-1">
        {campaignActionLabel && (
          <AccountMenuAction
            icon={<PortalMenuIcon src={promoSubscriptionIconUrl} darkInvert />}
            label={campaignActionLabel}
            onClick={handleCreditsResetActivity}
          />
        )}
        {finalRewards.map(reward => {
          const rewardText = getFinalRewardText(reward);
          return (
            <AccountMenuAction
              key={`${reward.campaignCode}:${reward.claimDeadline}`}
              icon={<PortalMenuIcon src={reward.presentation?.iconUrl || soccerBallIconUrl} darkInvert />}
              label={rewardText.actionText}
              onClick={() => handleFinalReward(reward)}
            />
          );
        })}
        <AccountMenuAction
          icon={<PortalMenuIcon src={inviteCreditsIconUrl} darkInvert />}
          label={i18nService.t('authInviteFriendsForCredits')}
          onClick={handleInvite}
        />
      </div>

      {/* Session action */}
      <div className="py-1">
        <AccountMenuAction
          icon={<PortalMenuIcon src={logoutIconUrl} darkInvert />}
          label={i18nService.t('authLogout')}
          onClick={handleLogout}
        />
      </div>
    </div>
  );
};

const formatRewardExpiry = (expiresAt: string): string => {
  const value = expiresAt.replace('T', ' ').slice(0, 19);
  return i18nService.getLanguage() === 'en' ? value : value.replace(/-/g, '/');
};

interface LoginButtonProps {
  contentLeftOffset?: number;
}

const LoginButton: React.FC<LoginButtonProps> = ({ contentLeftOffset = 0 }) => {
  const { isLoggedIn, isLoading, profileSummary, user } = useSelector((state: RootState) => state.auth);
  const enterpriseAccountContext = useSelector(selectEnterpriseAccountContext);
  const [showMenu, setShowMenu] = useState(false);
  const [showLoginForm, setShowLoginForm] = useState(false);
  const [selectedFinalRewardCode, setSelectedFinalRewardCode] = useState<string | null>(null);
  const [finalRewardLoading, setFinalRewardLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const finalRewards = useMemo(
    () => getFinalRewards(profileSummary?.creditsResetCampaign),
    [profileSummary?.creditsResetCampaign],
  );
  const finalReward = finalRewards.find(
    reward => reward.campaignCode === selectedFinalRewardCode,
  );
  const finalRewardText = getFinalRewardText(finalReward);
  const finalRewardOpen = finalReward !== undefined;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      const isEnterpriseAccountFlyout = target instanceof Element
        && target.closest('[data-enterprise-account-flyout="true"]') !== null;
      if (
        containerRef.current
        && !containerRef.current.contains(target as Node)
        && !isEnterpriseAccountFlyout
      ) {
        setShowMenu(false);
        setShowLoginForm(false);
      }
    };
    if (showMenu || showLoginForm) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMenu, showLoginForm]);

  useEffect(() => {
    if (!isLoggedIn || (selectedFinalRewardCode && !finalReward)) {
      setSelectedFinalRewardCode(null);
    }
    if (isLoggedIn) {
      setShowLoginForm(false);
    }
  }, [finalReward, isLoggedIn, selectedFinalRewardCode]);

  if (isLoading) {
    return null;
  }

  const handleClick = async () => {
    if (isLoggedIn) {
      const nextShowMenu = !showMenu;
      setShowMenu(nextShowMenu);
      const creditItemCount = profileSummary?.creditItems?.length ?? 0;
      reportAccountMenuAction(nextShowMenu ? 'open_menu' : 'close_menu', {
        creditItemCount,
        hasCredits: creditItemCount > 0,
        isLoggedIn: true,
      });
      return;
    }
    try {
      setShowLoginForm(!showLoginForm);
      reportAccountMenuAction('login', {
        isLoggedIn: false,
        result: 'success',
      });
    } catch (error) {
      reportAccountMenuAction('login', {
        isLoggedIn: false,
        result: 'failed',
      });
      throw error;
    }
  };

  const closeFinalReward = () => {
    if (finalRewardLoading) return;
    setSelectedFinalRewardCode(null);
  };

  const claimFinalReward = async () => {
    if (!finalReward || finalRewardLoading) return;
    setFinalRewardLoading(true);
    try {
      const claimed = await authService.claimCreditsFinalReward(finalReward.campaignCode);
      setSelectedFinalRewardCode(null);
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('authFinalRewardClaimSuccess')
          .replace('{credits}', formatCredits(claimed.creditsGranted))
          .replace('{date}', formatRewardExpiry(claimed.expiresAt)),
      }));
    } catch (error) {
      await authService.fetchProfileSummary();
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: error instanceof Error ? error.message : i18nService.t('authFinalRewardClaimFailed'),
      }));
    } finally {
      setFinalRewardLoading(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleClick}
        className="inline-flex h-7 items-center justify-start gap-2 rounded-md px-1.5 text-[14px] font-normal text-foreground/80 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04] cursor-pointer"
      >
        {isLoggedIn ? (
          <>
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="h-4 w-4 shrink-0 rounded-full" />
            ) : (
              <UserAvatarIcon className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate max-w-[80px]">{i18nService.t('myAccount')}</span>
          </>
        ) : (
          <>
            <UserAvatarIcon className="h-4 w-4 shrink-0" />
            {i18nService.t('login')}
          </>
        )}
      </button>
      {showLoginForm && !isLoggedIn && (
        <div className="absolute bottom-full left-[-0.5rem] z-50 mb-1 w-[16rem] rounded-xl border border-border bg-surface p-4 shadow-popover popover-enter">
          <div className="mb-3 text-sm font-medium text-foreground">
            {i18nService.t('litLoginTitle')}
          </div>
          <LitLoginForm onSuccess={() => setShowLoginForm(false)} />
        </div>
      )}
      {showMenu && isLoggedIn && (
        enterpriseAccountContext
          ? (
            <EnterpriseAccountMenu
              context={enterpriseAccountContext}
              onClose={() => setShowMenu(false)}
            />
          )
          : (
            <UserMenu
              onClose={() => setShowMenu(false)}
              onOpenFinalReward={setSelectedFinalRewardCode}
            />
          )
      )}
      <CreditsFinalRewardModal
        open={finalRewardOpen}
        loading={finalRewardLoading}
        contentLeftOffset={contentLeftOffset}
        campaignCode={finalReward?.campaignCode}
        creditsText={finalRewardText.creditsText}
        title={finalRewardText.title}
        actionText={finalRewardText.actionText}
        posterUrl={finalReward?.presentation?.posterUrl}
        onClose={closeFinalReward}
        onClaim={() => void claimFinalReward()}
      />
    </div>
  );
};

export default LoginButton;
