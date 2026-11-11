/**
 * Errors in the shape Epic services return:
 * { errorCode, errorMessage, messageVars, numericErrorCode, originatingService, intent }
 * plus the OAuth fields (error, error_description) where the account service uses them.
 */
export class EpicError extends Error {
  constructor(errorCode, errorMessage, { status = 400, numericErrorCode = 1000, messageVars = [], service = 'any', oauth = null } = {}) {
    super(errorMessage);
    this.errorCode = errorCode;
    this.status = status;
    this.numericErrorCode = numericErrorCode;
    this.messageVars = messageVars;
    this.service = service;
    this.oauth = oauth; // OAuth "error" value, e.g. "invalid_grant"
  }

  toJSON() {
    const body = {
      errorCode: this.errorCode,
      errorMessage: this.message,
      messageVars: this.messageVars,
      numericErrorCode: this.numericErrorCode,
      originatingService: this.service,
      intent: 'prod',
    };
    if (this.oauth) {
      body.error_description = this.message;
      body.error = this.oauth;
    }
    return body;
  }
}

const e = (code, msg, opts) => new EpicError(code, msg, opts);

export const Errors = {
  notFound: (what = 'the resource you were trying to find') =>
    e('errors.com.epicgames.common.not_found', `Sorry ${what} could not be found`, { status: 404, numericErrorCode: 1004 }),
  methodNotAllowed: () =>
    e('errors.com.epicgames.common.method_not_allowed', 'Sorry the resource you were trying to access cannot be accessed with the HTTP method you used.', { status: 405, numericErrorCode: 1009 }),
  badRequest: (msg = 'Sorry but your request is invalid') =>
    e('errors.com.epicgames.bad_request', msg, { status: 400, numericErrorCode: 1001 }),
  validation: (msg) => e('errors.com.epicgames.validation.validation_failed', msg, { status: 400, numericErrorCode: 1040 }),
  payloadTooLarge: () => e('errors.com.epicgames.common.payload_too_large', 'Request body is too large', { status: 413, numericErrorCode: 1001 }),
  internal: () => e('errors.com.epicgames.common.server_error', 'Sorry an error occurred and we were unable to resolve it.', { status: 500, numericErrorCode: 1000 }),

  // authentication / authorization
  authRequired: (path) =>
    e('errors.com.epicgames.common.authentication.authentication_failed', `Authentication failed for ${path}`, { status: 401, numericErrorCode: 1032, messageVars: [path], service: 'com.epicgames.account.public' }),
  invalidToken: (token) =>
    e('errors.com.epicgames.common.authentication.token_verification_failed', `Sorry the auth token '${token}' is invalid`, { status: 401, numericErrorCode: 1014, messageVars: [token], service: 'com.epicgames.account.public' }),
  missingPermission: (permission, action = 'ALL') =>
    e('errors.com.epicgames.common.missing_permission', `Sorry your login does not posses the permissions '${permission} ${action}' needed to perform the requested operation`, { status: 403, numericErrorCode: 1023, messageVars: [permission, action] }),
  invalidClient: () =>
    e('errors.com.epicgames.account.invalid_client_credentials', 'Sorry the client credentials you are using are invalid', { status: 401, numericErrorCode: 18033, service: 'com.epicgames.account.public', oauth: 'invalid_client' }),
  unsupportedGrant: (grant) =>
    e('errors.com.epicgames.common.oauth.unsupported_grant_type', `Unsupported grant type: ${grant}`, { status: 400, numericErrorCode: 1016, messageVars: [grant], service: 'com.epicgames.account.public', oauth: 'unsupported_grant_type' }),
  invalidRequest: (msg) =>
    e('errors.com.epicgames.common.oauth.invalid_request', msg, { status: 400, numericErrorCode: 1013, service: 'com.epicgames.account.public', oauth: 'invalid_request' }),
  invalidCredentials: () =>
    e('errors.com.epicgames.account.invalid_account_credentials', 'Your e-mail and/or password are incorrect. Please check them and try again.', { status: 400, numericErrorCode: 18031, service: 'com.epicgames.account.public', oauth: 'invalid_grant' }),
  accountBanned: (name) =>
    e('errors.com.epicgames.account.account_not_active', `Sorry the account ${name} is banned.`, { status: 400, numericErrorCode: 18006, messageVars: [name], service: 'com.epicgames.account.public', oauth: 'invalid_grant' }),
  exchangeCodeNotFound: () =>
    e('errors.com.epicgames.account.oauth.exchange_code_not_found', 'Sorry the exchange code you supplied was not found. It is possible that it was no longer valid', { status: 400, numericErrorCode: 18057, service: 'com.epicgames.account.public', oauth: 'invalid_grant' }),
  refreshTokenInvalid: (token) =>
    e('errors.com.epicgames.account.auth_token.invalid_refresh_token', `Sorry the refresh token '${token}' is invalid`, { status: 400, numericErrorCode: 18036, messageVars: [token], service: 'com.epicgames.account.public', oauth: 'invalid_grant' }),
  deviceAuthInvalid: () =>
    e('errors.com.epicgames.account.invalid_account_credentials', 'Sorry the device auth credentials are invalid', { status: 400, numericErrorCode: 18031, service: 'com.epicgames.account.public', oauth: 'invalid_grant' }),

  // accounts
  accountNotFound: (id) =>
    e('errors.com.epicgames.account.account_not_found', `Sorry, we couldn't find an account for ${id}`, { status: 404, numericErrorCode: 18007, messageVars: [id], service: 'com.epicgames.account.public' }),
  displayNameTaken: (name) =>
    e('errors.com.epicgames.account.display_name_taken', `The display name ${name} is already in use`, { status: 409, numericErrorCode: 18070, messageVars: [name], service: 'com.epicgames.account.public' }),

  // MCP
  operationNotFound: (op) =>
    e('errors.com.epicgames.fortnite.operation_not_found', `Operation ${op} not valid`, { status: 404, numericErrorCode: 16035, messageVars: [op], service: 'fortnite' }),
  operationForbidden: (op, route) =>
    e('errors.com.epicgames.fortnite.operation_forbidden', `Operation ${op} is not allowed on the ${route} route`, { status: 403, numericErrorCode: 12813, messageVars: [op, route], service: 'fortnite' }),
  profileNotFound: (profileId) =>
    e('errors.com.epicgames.modules.profiles.operation_forbidden', `Unable to find template configuration for profile ${profileId}`, { status: 403, numericErrorCode: 12813, messageVars: [profileId], service: 'fortnite' }),
  itemNotFound: (itemId) =>
    e('errors.com.epicgames.fortnite.item_not_found', `Locker item ${itemId} not found`, { status: 404, numericErrorCode: 16027, messageVars: [itemId], service: 'fortnite' }),
  invalidParameter: (msg) => e('errors.com.epicgames.fortnite.invalid_parameter', msg, { status: 400, numericErrorCode: 16034, service: 'fortnite' }),
  offerNotFound: (offerId) =>
    e('errors.com.epicgames.fortnite.id_invalid', `Offer ID (id: '${offerId}') not found`, { status: 400, numericErrorCode: 1040, messageVars: [offerId], service: 'fortnite' }),
  priceMismatch: (expected, actual) =>
    e('errors.com.epicgames.validation.validation_failed', `Expected total price of ${expected} did not match actual price ${actual}`, { status: 400, numericErrorCode: 1040, messageVars: [String(expected), String(actual)], service: 'fortnite' }),
  insufficientCurrency: (price, balance) =>
    e('errors.com.epicgames.currency.mtx.insufficient', `You can not afford this item (${price}), you only have ${balance}.`, { status: 400, numericErrorCode: 1040, messageVars: [String(price), String(balance)], service: 'fortnite' }),
  alreadyOwned: () => e('errors.com.epicgames.offer.already_owned', 'You have already bought this item before.', { status: 400, numericErrorCode: 1040, service: 'fortnite' }),
  purchaseNotFound: (id) => e('errors.com.epicgames.fortnite.item_not_found', `Purchase ${id} not found`, { status: 404, numericErrorCode: 16027, messageVars: [id], service: 'fortnite' }),
  giftsDisabled: (id) => e('errors.com.epicgames.user.gift_recipient_is_not_eligible', `${id} is not able to receive gifts`, { status: 403, numericErrorCode: 28004, messageVars: [id], service: 'fortnite' }),

  // friends / party
  friendNotFound: (id) => e('errors.com.epicgames.friends.friendship_not_found', `Friendship between you and ${id} does not exist`, { status: 404, numericErrorCode: 14004, messageVars: [id], service: 'friends' }),
  friendSelf: () => e('errors.com.epicgames.friends.cannot_friend_due_to_target_settings', 'You cannot add yourself as a friend', { status: 400, numericErrorCode: 14010, service: 'friends' }),
  partyNotFound: (id) => e('errors.com.epicgames.social.party.party_not_found', `Sorry, we couldn't find a party by id ${id}`, { status: 404, numericErrorCode: 51002, messageVars: [id], service: 'party' }),
  partyMemberNotFound: (id) => e('errors.com.epicgames.social.party.member_not_found', `Sorry, we couldn't find a member by id ${id}`, { status: 404, numericErrorCode: 51004, messageVars: [id], service: 'party' }),
  partyNotLeader: () => e('errors.com.epicgames.social.party.party_change_forbidden', 'The user is not the party captain', { status: 403, numericErrorCode: 51015, service: 'party' }),
  partyFull: (id) => e('errors.com.epicgames.social.party.party_is_full', `Party ${id} is full`, { status: 403, numericErrorCode: 51024, messageVars: [id], service: 'party' }),
  partyStaleRevision: (expected, got) =>
    e('errors.com.epicgames.social.party.stale_revision', `Sorry, your revision ${got} is out of date; current revision is ${expected}`, { status: 409, numericErrorCode: 51019, messageVars: [String(expected), String(got)], service: 'party' }),
  pingNotFound: () => e('errors.com.epicgames.social.party.ping_not_found', 'Sorry, we could not find a ping', { status: 404, numericErrorCode: 51021, service: 'party' }),

  // matchmaking
  sessionNotFound: (id) => e('errors.com.epicgames.common.matchmaking.session.not_found', `Sorry the session ${id} could not be found`, { status: 404, numericErrorCode: 12101, messageVars: [id], service: 'fortnite' }),
};
