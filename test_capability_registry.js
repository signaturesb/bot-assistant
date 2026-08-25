'use strict';

const assert = require('assert');
const fs = require('fs');

const bot = fs.readFileSync('bot.js', 'utf8');
const registry = fs.readFileSync('docs/CAPABILITY_REGISTRY.md', 'utf8');

assert.match(bot, /La liste TOOLS fournie par l'application est la seule vérité/);
assert.match(bot, /Un aperçu n'est jamais une preuve d'envoi/);
assert.match(bot, /Ne jamais paralléliser deux écritures/);
assert.match(bot, /La mémoire persistante conserve les faits stables/);
assert.match(registry, /Les skills et connecteurs de Codex.*ne deviennent pas automatiquement des outils Telegram/);
assert.match(registry, /confirmation au contenu exact/);
assert.match(registry, /Ne jamais mémoriser de secret/);

console.log('✅ Registre de capacités et règles de routage avancées présents');
