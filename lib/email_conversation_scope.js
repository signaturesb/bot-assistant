'use strict';

function makeEmailConversationScope(text, now = Date.now()) {
  const value = String(text || '');
  const recipients = [...new Set((value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(x => x.toLowerCase()))];
  const listings = [...new Set(value.match(/\b\d{7,9}\b/g) || [])];
  return { recipients, listings, createdAt: now };
}

function shouldSupersedePendingEmail(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  // Une confirmation pure vise l'aperçu courant. Toute autre instruction
  // devient le nouveau contexte autoritaire et révoque les anciens aperçus.
  if (/^(?:envoie|send)[!.]?$/i.test(value)) return false;
  if (/^confirme\s+\S+@\S+[!.]?$/i.test(value)) return false;
  return true;
}

function emailMatchesConversationScope(scope, summary, action, replyId = 0) {
  // A reply never authorizes a different preview, even when only one remains.
  if (replyId && Number(replyId) !== Number(action?.telegramPreviewMessageId || 0)) return false;
  if (!scope || !Number.isFinite(scope.createdAt)) return false;
  if (Number(action?.createdAt || 0) < scope.createdAt) return false;
  const to = String(summary?.to || '').trim().toLowerCase();
  const listing = String(summary?.centris || '').trim();
  if (scope.recipients.length && (scope.recipients.length !== 1 || !scope.recipients.includes(to))) return false;
  if (scope.listings.length && !scope.listings.includes(listing)) return false;
  // An untargeted discussion cannot authorize an unsolicited background draft.
  return scope.recipients.length === 1 || Boolean(replyId);
}

module.exports = {
  makeEmailConversationScope,
  emailMatchesConversationScope,
  shouldSupersedePendingEmail,
};
