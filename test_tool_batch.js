'use strict';

const assert = require('assert');
const { isMutatingTool, executeToolBatch } = require('./lib/tool_batch');

async function main() {
  assert.strictEqual(isMutatingTool('voir_pipeline'), false);
  assert.strictEqual(isMutatingTool('envoyer_email'), true);
  assert.strictEqual(isMutatingTool('write_github_file'), true);

  let active = 0;
  let maxActive = 0;
  const execute = async (block) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return block.name;
  };

  const reads = [{ name: 'voir_pipeline' }, { name: 'chercher_prospect' }];
  assert.deepStrictEqual(await executeToolBatch(reads, execute), ['voir_pipeline', 'chercher_prospect']);
  assert.strictEqual(maxActive, 2, 'les lectures indépendantes devraient rester parallèles');

  active = 0;
  maxActive = 0;
  const mixed = [{ name: 'chercher_prospect' }, { name: 'ajouter_note' }, { name: 'voir_pipeline' }];
  assert.deepStrictEqual(await executeToolBatch(mixed, execute), ['chercher_prospect', 'ajouter_note', 'voir_pipeline']);
  assert.strictEqual(maxActive, 1, 'un lot contenant une écriture doit être séquentiel');

  console.log('✅ Lots outils: lectures parallèles, écritures séquentielles');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
