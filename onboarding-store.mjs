import { database } from "./database.mjs";
import { AppError } from "./errors.mjs";

const onboardingByUser = database.prepare(`
  SELECT user_id, onboarding_version, completed_at, last_verified_at, updated_at
  FROM user_onboarding WHERE user_id = ? AND onboarding_version = ? LIMIT 1
`);
const upsertOnboarding = database.prepare(`
  INSERT INTO user_onboarding(user_id, onboarding_version, completed_at, last_verified_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id, onboarding_version) DO UPDATE SET
    completed_at = excluded.completed_at,
    last_verified_at = excluded.last_verified_at,
    updated_at = excluded.updated_at
`);
const instanceSetup = database.prepare(`
  SELECT owner_user_id, claimed_at, updated_at FROM instance_setup WHERE singleton = 1
`);
const claimInstanceSetup = database.prepare(`
  UPDATE instance_setup SET owner_user_id = ?, claimed_at = ?, updated_at = ?
  WHERE singleton = 1 AND owner_user_id IS NULL
`);

function clean(value, maximum = 200) {
  return String(value || "").trim().slice(0, maximum);
}

export function onboardingStatus({ userId, onboardingVersion }) {
  const row = onboardingByUser.get(clean(userId), clean(onboardingVersion));
  return {
    version: clean(onboardingVersion),
    completed: Boolean(row?.completed_at),
    completedAt: row?.completed_at || null,
    lastVerifiedAt: row?.last_verified_at || null
  };
}

export function setupAdministration({ userId, authMode, webConfigurationEnabled }) {
  const row = instanceSetup.get() || {};
  const localMode = authMode === "local-username";
  return {
    webConfigurationEnabled: Boolean(webConfigurationEnabled),
    ownerClaimed: Boolean(row.owner_user_id),
    isOwner: Boolean(row.owner_user_id && row.owner_user_id === clean(userId)),
    canManage: Boolean(webConfigurationEnabled && localMode && (!row.owner_user_id || row.owner_user_id === clean(userId)))
  };
}

export const claimSetupAdministration = database.transaction(({ userId, authMode, webConfigurationEnabled }) => {
  const scopedUserId = clean(userId);
  const access = setupAdministration({ userId: scopedUserId, authMode, webConfigurationEnabled });
  if (!access.canManage) {
    throw new AppError("当前用户不能修改实例级核心配置", {
      code: "setup_configuration_forbidden",
      status: 403,
      expose: true
    });
  }
  if (!access.ownerClaimed) {
    const now = new Date().toISOString();
    claimInstanceSetup.run(scopedUserId, now, now);
  }
  return setupAdministration({ userId: scopedUserId, authMode, webConfigurationEnabled });
});

export function completeOnboarding({ userId, onboardingVersion }) {
  const now = new Date().toISOString();
  upsertOnboarding.run(clean(userId), clean(onboardingVersion), now, now, now);
  return onboardingStatus({ userId, onboardingVersion });
}

export function onboardingStoreStatus() {
  const completed = database.prepare("SELECT COUNT(*) AS count FROM user_onboarding WHERE completed_at IS NOT NULL").get();
  const owner = instanceSetup.get();
  return {
    configured: true,
    completed_users: Number(completed?.count || 0),
    configuration_owner_claimed: Boolean(owner?.owner_user_id)
  };
}
