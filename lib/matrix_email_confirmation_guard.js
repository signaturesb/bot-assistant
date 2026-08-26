'use strict';

const MATRIX_SINGLE_CONFIRM_RE = /^(?:confirme|envoie)$/i;

function normalizeRecipient(value) {
  return String(value || '').trim().toLowerCase();
}

function matrixConfirmationFailure(code, message) {
  return { ok: false, code, message };
}

/**
 * Transition synchrone et atomique de PREVIEW vers SENDING.
 * Tous les contrôles surviennent avant la première mutation. persist() doit
 * être synchrone et durable; en cas d'échec, l'état en mémoire est restauré.
 */
function claimMatrixEmailConfirmation({
  chatId,
  allowedChatId,
  requestId,
  previewMessageId,
  recipient,
  action,
  artifact,
  clientEligible,
  confirmationVersion,
  persist,
  now = Date.now(),
}) {
  const allowed = Number(allowedChatId || 0);
  if (!Number.isInteger(allowed) || allowed <= 0 || Number(chatId) !== allowed) {
    return matrixConfirmationFailure('MATRIX_CONFIRM_CHAT_UNAUTHORIZED', 'conversation Telegram non autorisée');
  }
  if (!action || action.name !== 'telecharger_annexes_centris') {
    return matrixConfirmationFailure('MATRIX_CONFIRM_ACTION_MISSING', 'aperçu Matrix absent');
  }
  if (!requestId || String(action.requestId || '') !== String(requestId)) {
    return matrixConfirmationFailure('MATRIX_CONFIRM_REQUEST_MISMATCH', 'identifiant de demande remplacé ou incorrect');
  }
  if (!Number(previewMessageId) || Number(action.telegramPreviewMessageId || 0) !== Number(previewMessageId)) {
    return matrixConfirmationFailure('MATRIX_CONFIRM_PREVIEW_MISMATCH', 'confirmation non liée au message d’aperçu exact');
  }
  if (Number(action.confirmationVersion || 0) !== Number(confirmationVersion || 0)) {
    return matrixConfirmationFailure('MATRIX_CONFIRM_VERSION_MISMATCH', 'ancienne version de confirmation');
  }
  if (action.confirmationStage !== 'preview' || action.correctionMode) {
    return matrixConfirmationFailure('MATRIX_CONFIRM_STAGE_INVALID', 'aperçu non confirmable ou correction en cours');
  }
  if (!Number.isFinite(action.matrixPreviewExpiresAt) || now > action.matrixPreviewExpiresAt) {
    return matrixConfirmationFailure('MATRIX_CONFIRM_EXPIRED', 'aperçu expiré');
  }
  if (action.inFlight) {
    return matrixConfirmationFailure('MATRIX_CONFIRM_ALREADY_IN_FLIGHT', 'tentative déjà en cours');
  }
  if (action.deliveryUncertain || action.ambiguousAfterRestart || action.attemptStartedAt) {
    return matrixConfirmationFailure('MATRIX_CONFIRM_DELIVERY_UNCERTAIN', 'état de livraison incertain');
  }
  if (!clientEligible) {
    return matrixConfirmationFailure('MATRIX_CONFIRM_CLIENT_INELIGIBLE', 'client incomplet ou ambigu');
  }

  const expectedRecipient = normalizeRecipient(action.input?.email_destination);
  if (!expectedRecipient || normalizeRecipient(recipient) !== expectedRecipient) {
    return matrixConfirmationFailure('MATRIX_CONFIRM_RECIPIENT_MISMATCH', 'destinataire différent de l’aperçu');
  }
  const expectedNum = String(action.input?.centris_num || '');
  if (!artifact || String(artifact.requestId || '') !== String(requestId) ||
      String(artifact.num || '') !== expectedNum ||
      String(artifact.fingerprint || '') !== String(action.matrixFingerprint || '') ||
      normalizeRecipient(artifact.recipient) !== expectedRecipient ||
      Number(artifact.expiresAt || 0) !== Number(action.matrixPreviewExpiresAt || 0) ||
      now > Number(artifact.expiresAt || 0) ||
      !Array.isArray(artifact.documents) || artifact.documents.length === 0) {
    return matrixConfirmationFailure('MATRIX_CONFIRM_ARTIFACT_MISMATCH', 'PDF figés absents, expirés ou différents');
  }
  if (typeof persist !== 'function') {
    return matrixConfirmationFailure('MATRIX_CONFIRM_PERSIST_MISSING', 'persistance transactionnelle absente');
  }

  const previous = {
    confirmationStage: action.confirmationStage,
    inFlight: action.inFlight,
    attemptStartedAt: action.attemptStartedAt,
    singleConfirmationPreviewMessageId: action.singleConfirmationPreviewMessageId,
  };
  action.confirmationStage = 'sending';
  action.inFlight = true;
  action.attemptStartedAt = now;
  action.singleConfirmationPreviewMessageId = Number(previewMessageId);
  if (!persist()) {
    Object.assign(action, previous);
    return matrixConfirmationFailure('MATRIX_CONFIRM_PERSIST_FAILED', 'verrou durable impossible à enregistrer');
  }
  return { ok: true, code: 'MATRIX_CONFIRM_CLAIMED', action, artifact };
}

function releaseMatrixEmailConfirmation(action, outcome) {
  if (!action) return;
  action.inFlight = false;
  if (outcome === 'deterministic-failure') {
    action.attemptStartedAt = null;
    action.deliveryUncertain = false;
    action.confirmationStage = 'preview';
    action.singleConfirmationPreviewMessageId = null;
    return;
  }
  if (outcome === 'uncertain') {
    action.deliveryUncertain = true;
    action.confirmationStage = 'uncertain';
  }
}

module.exports = {
  MATRIX_SINGLE_CONFIRM_RE,
  claimMatrixEmailConfirmation,
  releaseMatrixEmailConfirmation,
};
