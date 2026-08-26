'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const cua = require('./cua_driver');

const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1500, 1)]);
let closed = false;
let navigation = null;
const context = {
  async newPage() {
    return {
      async goto(url, options) {
        navigation = { url, options };
        return {
          ok: () => true,
          status: () => 200,
          headers: () => ({ 'content-type': 'application/pdf' }),
          body: async () => pdf,
        };
      },
      async close() { closed = true; },
    };
  },
};

(async () => {
  const result = await cua._downloadMatrixPdfInBrowser(
    context,
    'https://mediaserver.centris.ca/media.ashx?t=di&id=abc',
    'https://matrix.centris.ca/Matrix/Results.aspx?c=xyz'
  );
  assert.deepStrictEqual(result, pdf);
  assert.strictEqual(navigation.options.referer, 'https://matrix.centris.ca/Matrix/Results.aspx?c=xyz');
  assert.strictEqual(navigation.options.waitUntil, 'commit');
  assert.strictEqual(closed, true);

  const popupContext = new EventEmitter();
  let popupClosed = false;
  let trustedAnchorClicked = false;
  const popup = { async close() { popupClosed = true; } };
  const opener = {
    url: () => navigation.options.referer,
    locator(selector) {
      assert.match(selector, /media\.ashx/);
      return {
        count: async () => 1,
        nth() {
          return {
            getAttribute: async () => 'https://mediaserver.centris.ca/media.ashx?id=popup',
            async click() {
              trustedAnchorClicked = true;
              popupContext.emit('response', {
                url: () => 'https://mediaserver.centris.ca/media.ashx?id=popup',
                headers: () => ({ 'content-type': 'application/pdf' }),
                body: async () => pdf,
              });
            },
          };
        },
      };
    },
    async waitForEvent(event) { assert.strictEqual(event, 'popup'); return popup; },
  };
  const popupResult = await cua._downloadMatrixPdfInBrowser(
    popupContext,
    'https://mediaserver.centris.ca/media.ashx?id=popup',
    navigation.options.referer,
    opener,
  );
  assert.deepStrictEqual(popupResult, pdf);
  assert.strictEqual(trustedAnchorClicked, true, 'le vrai lien Matrix doit être cliqué');
  assert.strictEqual(popupClosed, true, 'le popup Matrix doit être fermé');
  const oversizedContext = {
    async newPage() {
      return {
        async goto() {
          return { ok: () => true, status: () => 200, headers: () => ({ 'content-type': 'application/pdf', 'content-length': String(26 * 1024 * 1024) }), body: async () => pdf };
        },
        async close() {},
      };
    },
  };
  await assert.rejects(
    () => cua._downloadMatrixPdfInBrowser(oversizedContext, 'https://mediaserver.centris.ca/media.ashx?id=large', navigation.options.referer),
    /MATRIX_DOCUMENT_TOO_LARGE/
  );
  await assert.rejects(
    () => cua._downloadMatrixPdfInBrowser(context, 'https://example.com/file.pdf', navigation.options.referer),
    /MATRIX_DOCUMENT_URL_REJECTED/
  );
  const ordered = await cua._mapWithConcurrency([1, 2, 3, 4], 2, async (value) => value * 2);
  assert.deepStrictEqual(ordered, [2, 4, 6, 8]);
  const authenticatedContext = {
    request: {
      async get(url, options) {
        assert.match(url, /^https:\/\/mediaserver\.centris\.ca\//);
        assert.strictEqual(options.headers.Referer, navigation.options.referer);
        return { ok: () => true, status: () => 200, headers: () => ({ 'content-type': 'application/pdf' }), body: async () => pdf };
      },
    },
    async newPage() { throw new Error('fallback navigateur ne doit pas être utilisé'); },
  };
  assert.deepStrictEqual(
    await cua._downloadMatrixPdfAuthenticated(authenticatedContext, 'https://mediaserver.centris.ca/media.ashx?id=direct', navigation.options.referer),
    pdf
  );
  let oversizedFallbackPages = 0;
  const authenticatedOversizedContext = {
    request: {
      async get() {
        return { ok: () => true, status: () => 200, headers: () => ({ 'content-length': String(26 * 1024 * 1024) }) };
      },
    },
    async newPage() { oversizedFallbackPages += 1; throw new Error('fallback interdit'); },
  };
  await assert.rejects(
    () => cua._downloadMatrixPdfAuthenticated(
      authenticatedOversizedContext,
      'https://mediaserver.centris.ca/media.ashx?id=oversized-direct',
      navigation.options.referer,
    ),
    /MATRIX_DOCUMENT_TOO_LARGE/,
  );
  assert.strictEqual(oversizedFallbackPages, 0, 'un fichier trop volumineux ne doit pas ouvrir un onglet Browserless');
  const authenticatedFallbackContext = new EventEmitter();
  authenticatedFallbackContext.request = {
    async get() {
      return { ok: () => true, status: () => 200, headers: () => ({ 'content-type': 'text/html' }), body: async () => Buffer.from('<html>wrapper</html>') };
    },
  };
  const fallbackOpener = {
    async waitForEvent() { return { async close() {} }; },
    async evaluate(_fn, href) {
      authenticatedFallbackContext.emit('response', {
        url: () => href,
        headers: () => ({ 'content-type': 'application/pdf' }),
        body: async () => pdf,
      });
    },
  };
  assert.deepStrictEqual(
    await cua._downloadMatrixPdfAuthenticated(
      authenticatedFallbackContext,
      'https://mediaserver.centris.ca/media.ashx?id=fallback',
      navigation.options.referer,
      fallbackOpener,
    ),
    pdf,
    'une réponse API enveloppée doit basculer vers le clic authentifié Matrix',
  );
  const actionContext = new EventEmitter();
  let actionClicks = 0;
  const actionPage = {
    frames() {
      return [{
        locator(selector) {
          assert.strictEqual(selector, 'xpath=//*[@id="ctl00_DV_Link"]');
          return {
            first() { return this; },
            async isVisible() { return true; },
            async click() {
              actionClicks += 1;
              actionContext.emit('response', {
                url: () => 'https://mediaserver.centris.ca/media.ashx?id=dv',
                headers: () => ({ 'content-type': 'application/pdf', 'content-length': String(pdf.length) }),
                body: async () => pdf,
              });
            },
          };
        },
      }];
    },
  };
  assert.deepStrictEqual(
    await cua._downloadMatrixPdfByAction(actionContext, actionPage, 'ctl00_DV_Link'),
    pdf,
    'une DV ASP.NET sans URL directe doit être téléchargée par son vrai clic',
  );
  assert.strictEqual(actionClicks, 1);
  let labelClicks = 0;
  const labelContext = new EventEmitter();
  const labelControl = {
    async isVisible() { return true; },
    async innerText() { return 'DV-50037'; },
    async click() {
      labelClicks += 1;
      labelContext.emit('response', {
        url: () => 'https://mediaserver.centris.ca/media.ashx?id=dv-label',
        headers: () => ({ 'content-type': 'application/pdf' }),
        body: async () => pdf,
      });
    },
  };
  const labelPage = { frames: () => [{
    getByText: () => ({ first: () => labelControl }),
    locator: () => ({ count: async () => 0, nth: () => labelControl }),
  }] };
  assert.deepStrictEqual(
    await cua._downloadMatrixPdfByAction(labelContext, labelPage, null, 'DV-50037'),
    pdf,
    'une DV principale sans URL/id doit être téléchargée par son libellé exact',
  );
  assert.strictEqual(labelClicks, 1);
  const reportContext = new EventEmitter();
  let reportPhase = 0;
  const reportControl = (label, onClick) => ({
    async isVisible() { return true; },
    async evaluate() { return label; },
    async click() { await onClick(); },
  });
  const reportFrame = {
    locator(selector) {
      assert.strictEqual(selector, 'a,button,input');
      const controls = reportPhase === 0
        ? [reportControl('Imprimer', async () => { reportPhase = 1; })]
        : [reportControl('Imprimer en PDF', async () => {
          reportContext.emit('response', {
            url: () => 'https://matrix.centris.ca/Matrix/Printing/report.pdf',
            headers: () => ({ 'content-type': 'application/pdf' }),
            body: async () => pdf,
          });
        })];
      return { count: async () => controls.length, nth: (index) => controls[index] };
    },
    async evaluate(_fn, title) {
      return /Détaillé client/.test(String(title));
    },
  };
  const reportPage = {
    frames: () => [reportFrame],
    url: () => reportPhase === 0
      ? 'https://matrix.centris.ca/Matrix/Results.aspx'
      : 'https://matrix.centris.ca/Matrix/Printing/PrintOptions.aspx',
    async waitForURL(pattern) { assert.match('/Matrix/Printing/PrintOptions.aspx', pattern); },
    async waitForTimeout() {},
  };
  assert.deepStrictEqual(
    await cua._downloadMatrixListingReport(reportContext, reportPage),
    pdf,
    'la fiche détaillée officielle doit être capturée par Imprimer en PDF',
  );
  const retryReportContext = new EventEmitter();
  reportPhase = 1;
  const originalEmit = reportContext.emit.bind(reportContext);
  reportContext.emit = (...args) => retryReportContext.emit(...args);
  assert.deepStrictEqual(
    await cua._downloadMatrixListingReport(retryReportContext, reportPage),
    pdf,
    'une reprise déjà rendue sur PrintOptions ne doit pas rechercher le bouton Imprimer de la fiche',
  );
  reportContext.emit = originalEmit;

  let installedRoute = null;
  let removedRoute = null;
  let abortedPrintRequest = false;
  const interceptedContext = {
    async route(pattern, handler) { installedRoute = { pattern, handler }; },
    async unroute(pattern, handler) { removedRoute = { pattern, handler }; },
  };
  const capturedPrintRequest = await cua._captureMatrixPrintPRequest(
    interceptedContext,
    async () => {
      await installedRoute.handler({
        async abort(reason) {
          assert.strictEqual(reason, 'blockedbyclient');
          abortedPrintRequest = true;
        },
      }, {
        url: () => 'https://matrix.centris.ca/Matrix/PrintP?id=album',
        method: () => 'POST',
        postDataBuffer: () => Buffer.from('format=album'),
        allHeaders: async () => ({
          'content-type': 'application/x-www-form-urlencoded',
          referer: 'https://matrix.centris.ca/Matrix/Printing/PrintOptions.aspx',
          'user-agent': 'Matrix-test-agent',
        }),
      });
    },
    100,
  );
  assert.strictEqual(installedRoute.pattern, '**/Matrix/PrintP*');
  assert.strictEqual(removedRoute.handler, installedRoute.handler, 'la route temporaire doit toujours être retirée');
  assert.strictEqual(abortedPrintRequest, true, 'le PrintP navigateur concurrent doit être annulé');
  assert.strictEqual(capturedPrintRequest.method, 'POST');
  assert.strictEqual(capturedPrintRequest.body.toString(), 'format=album');

  const responseCaptureContext = new EventEmitter();
  responseCaptureContext.route = async () => {};
  responseCaptureContext.unroute = async () => {};
  const responseCapturedRequest = await cua._captureMatrixPrintPRequest(
    responseCaptureContext,
    async () => responseCaptureContext.emit('response', {
      url: () => 'https://matrix.centris.ca/Matrix/PrintP?id=redirect-chain',
      request: () => ({
        url: () => 'https://matrix.centris.ca/Matrix/PrintP?id=redirect-chain',
        method: () => 'GET',
        postDataBuffer: () => null,
        headers: () => ({ referer: 'https://matrix.centris.ca/Matrix/Printing/PrintOptions.aspx' }),
      }),
    }),
    100,
  );
  assert.match(responseCapturedRequest.url, /\/Matrix\/PrintP\?id=redirect-chain$/);
  assert.strictEqual(responseCapturedRequest.method, 'GET');

  const nativeAlbumPdf = Buffer.concat([
    Buffer.from('%PDF-1.7\n'),
    Buffer.alloc(1500, 2),
    Buffer.from('\n%%EOF'),
  ]);
  const browserRootSession = new EventEmitter();
  let browserRootDetached = false;
  let browserFetchEnabled = false;
  let browserStreamRead = false;
  let browserAutoAttachDisabled = false;
  browserRootSession.detach = async () => { browserRootDetached = true; };
  browserRootSession.send = async (method, params) => {
    if (method === 'Target.setDiscoverTargets') return {};
    if (method === 'Target.setAutoAttach') {
      if (params.autoAttach) {
        browserRootSession.emit('Target.attachedToTarget', {
          sessionId: 'page-session-1',
          targetInfo: { type: 'page' },
        });
      } else {
        browserAutoAttachDisabled = true;
      }
      return {};
    }
    if (method !== 'Target.sendMessageToTarget') throw new Error(`commande browser CDP inattendue: ${method}`);
    const command = JSON.parse(params.message);
    let result = {};
    if (command.method === 'Fetch.enable') browserFetchEnabled = true;
    else if (command.method === 'Fetch.takeResponseBodyAsStream') {
      assert.strictEqual(command.params.requestId, 'paused-print-1');
      result = { stream: 'print-stream-1' };
    } else if (command.method === 'IO.read') {
      assert.strictEqual(command.params.handle, 'print-stream-1');
      browserStreamRead = true;
      result = { data: nativeAlbumPdf.toString('base64'), base64Encoded: true, eof: false };
    } else if (!['Runtime.runIfWaitingForDebugger', 'Page.stopLoading', 'IO.close'].includes(command.method)) {
      throw new Error(`commande enfant CDP inattendue: ${command.method}`);
    }
    browserRootSession.emit('Target.receivedMessageFromTarget', {
      sessionId: params.sessionId,
      message: JSON.stringify({ id: command.id, result }),
    });
    return {};
  };
  const browserCdpContext = {
    browser: () => ({ async newBrowserCDPSession() { return browserRootSession; } }),
  };
  assert.deepStrictEqual(
    await cua._waitForMatrixPdfViaBrowserCdp(
      browserCdpContext,
      async () => browserRootSession.emit('Target.receivedMessageFromTarget', {
        sessionId: 'page-session-1',
        message: JSON.stringify({
          method: 'Fetch.requestPaused',
          params: {
            requestId: 'paused-print-1',
            request: { url: 'https://matrix.centris.ca/Matrix/PrintP?id=single-use' },
            responseStatusCode: 200,
          },
        }),
      }),
      1000,
    ),
    nativeAlbumPdf,
    'le CDP navigateur doit suspendre la réponse PrintP unique et lire son flux IO jusqu’à %%EOF',
  );
  assert.strictEqual(browserFetchEnabled, true);
  assert.strictEqual(browserStreamRead, true);
  assert.strictEqual(browserAutoAttachDisabled, true);
  assert.strictEqual(browserRootDetached, true);

  const cdpSession = new EventEmitter();
  let cdpDetached = false;
  let cdpStopped = false;
  cdpSession.send = async (method, params) => {
    if (method === 'Network.enable') return {};
    if (method === 'Network.streamResourceContent') {
      assert.strictEqual(params.requestId, 'print-request-1');
      return { bufferedData: nativeAlbumPdf.toString('base64') };
    }
    if (method === 'Page.stopLoading') { cdpStopped = true; return {}; }
    throw new Error(`commande CDP inattendue: ${method}`);
  };
  cdpSession.detach = async () => { cdpDetached = true; };
  assert.deepStrictEqual(
    await cua._waitForMatrixPdfViaCdp(
      { async newCDPSession() { return cdpSession; } },
      {},
      async () => cdpSession.emit('Network.responseReceived', {
        requestId: 'print-request-1',
        response: {
          url: 'https://matrix.centris.ca/Matrix/PrintP?id=cdp-album',
          mimeType: 'application/pdf',
        },
      }),
      1000,
    ),
    nativeAlbumPdf,
    'le flux original PrintP doit être lu par CDP jusqu’à %%EOF sans seconde requête',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(cdpStopped, true);
  assert.strictEqual(cdpDetached, true);

  const cdpOpenerPage = { name: 'print-options' };
  const cdpPopupPage = { name: 'print-popup' };
  const cdpOpenerSession = new EventEmitter();
  const cdpPopupSession = new EventEmitter();
  let popupPrintRoute = null;
  let popupPrintRouteRemoved = false;
  let popupCdpUsed = false;
  for (const session of [cdpOpenerSession, cdpPopupSession]) {
    session.detach = async () => {};
  }
  cdpOpenerSession.send = async (method) => {
    if (method === 'Network.enable') return {};
    throw new Error(`commande CDP opener inattendue: ${method}`);
  };
  cdpPopupSession.send = async (method, params) => {
    if (method === 'Network.enable') return {};
    if (method === 'Network.streamResourceContent') {
      popupCdpUsed = true;
      assert.strictEqual(params.requestId, 'popup-print-request');
      return { bufferedData: nativeAlbumPdf.toString('base64') };
    }
    if (method === 'Page.stopLoading') return {};
    throw new Error(`commande CDP popup inattendue: ${method}`);
  };
  const cdpPopupContext = {
    async newCDPSession(targetPage) {
      return targetPage === cdpPopupPage ? cdpPopupSession : cdpOpenerSession;
    },
    async route(pattern, handler) {
      assert.strictEqual(pattern, '**/Matrix/PrintP*');
      popupPrintRoute = handler;
    },
    async unroute(pattern, handler) {
      assert.strictEqual(pattern, '**/Matrix/PrintP*');
      assert.strictEqual(handler, popupPrintRoute);
      popupPrintRouteRemoved = true;
    },
  };
  assert.deepStrictEqual(
    await cua._waitForMatrixPdfViaCdp(
      cdpPopupContext,
      cdpOpenerPage,
      async () => popupPrintRoute({
        async continue() {
          cdpPopupSession.emit('Network.responseReceived', {
            requestId: 'popup-print-request',
            response: {
              url: 'https://matrix.centris.ca/Matrix/PrintP?id=popup-album',
              mimeType: 'text/html',
            },
          });
        },
        async abort() { throw new Error('la requête PrintP ne doit pas être annulée'); },
      }, {
        frame: () => ({ page: () => cdpPopupPage }),
      }),
      1000,
    ),
    nativeAlbumPdf,
    'le PrintP ouvert dans un popup doit être suspendu, branché au CDP du popup puis continué une seule fois',
  );
  assert.strictEqual(popupCdpUsed, true);
  assert.strictEqual(popupPrintRouteRemoved, true);

  const originalFetch = global.fetch;
  let replayedRequest = null;
  global.fetch = async (url, options) => {
    replayedRequest = { url, options };
    if (/\/Matrix\/Printing\/PrintOptions\.aspx/i.test(url)) {
      return new Response(null, {
        status: 302,
        headers: { location: '/Matrix/PrintP?id=redirected-album' },
      });
    }
    return new Response(nativeAlbumPdf, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    });
  };
  try {
    assert.deepStrictEqual(
      await cua._streamMatrixPdfUntilEof(
        capturedPrintRequest.url,
        'matrix=session-cookie',
        1000,
        capturedPrintRequest,
      ),
      nativeAlbumPdf,
      'le seul PrintP autorisé doit être lu jusqu’à %%EOF',
    );
    assert.strictEqual(replayedRequest.options.method, 'POST');
    assert.strictEqual(replayedRequest.options.body.toString(), 'format=album');
    assert.strictEqual(replayedRequest.options.headers.Cookie, 'matrix=session-cookie');
    assert.strictEqual(replayedRequest.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepStrictEqual(
      await cua._streamMatrixPdfUntilEof(
        'https://matrix.centris.ca/Matrix/Printing/PrintOptions.aspx',
        'matrix=session-cookie',
        1000,
        capturedPrintRequest,
      ),
      nativeAlbumPdf,
      'un POST PrintOptions doit suivre seulement sa redirection Matrix PrintP autorisée',
    );
    assert.match(replayedRequest.url, /\/Matrix\/PrintP\?id=redirected-album$/);
    assert.strictEqual(replayedRequest.options.method, 'GET', 'un POST suivi d’un 302 doit devenir un GET sans corps');
    let liveRoute = null;
    let nativeFlowPageClosed = false;
    const nativeFlowContext = {
      async storageState() {
        return { cookies: [{ name: 'matrix', value: 'session-cookie', domain: '.matrix.centris.ca' }] };
      },
      async route(pattern, handler) { liveRoute = { pattern, handler }; },
      async unroute() { liveRoute = null; },
    };
    const nativePrintControl = reportControl('Imprimer en PDF', async () => {
      await liveRoute.handler({ async abort() {} }, {
        url: () => 'https://matrix.centris.ca/Matrix/PrintP?id=full-flow',
        method: () => 'GET',
        postDataBuffer: () => null,
        allHeaders: async () => ({
          referer: 'https://matrix.centris.ca/Matrix/Printing/PrintOptions.aspx',
        }),
      });
    });
    const nativeFlowPage = {
      url: () => 'https://matrix.centris.ca/Matrix/Printing/PrintOptions.aspx',
      frames: () => [{
        locator: () => ({ count: async () => 1, nth: () => nativePrintControl }),
        async evaluate(_fn, title) { return /Détaillé client avec album/.test(String(title)); },
      }],
      async waitForTimeout() {},
      async close() { nativeFlowPageClosed = true; },
    };
    assert.deepStrictEqual(
      await cua._downloadMatrixListingReport(nativeFlowContext, nativeFlowPage),
      nativeAlbumPdf,
      'le parcours complet doit retourner la fiche album native et non une capture de page',
    );
    assert.strictEqual(nativeFlowPageClosed, true, 'la page d’impression doit libérer toute réponse PrintP avant la lecture unique');
    assert.strictEqual(replayedRequest.options.method, 'GET');
    assert.strictEqual(replayedRequest.options.headers.Cookie, 'matrix=session-cookie');
  } finally {
    global.fetch = originalFetch;
  }
  await assert.rejects(
    () => cua._streamMatrixPdfUntilEof('https://example.com/Matrix/PrintP', 'cookie', 100),
    /MATRIX_PRINT_STREAM_URL_REJECTED/,
  );

  const downloadOnlyContext = new EventEmitter();
  let downloadTriggered = false;
  const downloadOnlyPage = {
    async waitForEvent(event) {
      assert.strictEqual(event, 'download');
      while (!downloadTriggered) await new Promise((resolve) => setImmediate(resolve));
      return { async createReadStream() { return Readable.from([pdf]); } };
    },
  };
  assert.deepStrictEqual(
    await cua._waitForMatrixPdfOrDownload(downloadOnlyContext, downloadOnlyPage, async () => { downloadTriggered = true; }, 100),
    pdf,
    'un vrai événement download doit être capturé même sans corps de réponse réseau exploitable',
  );
  assert.strictEqual(cua._isMatrixDocumentRetryable(new Error('MATRIX_DOCUMENT_TOO_LARGE')), false);
  assert.strictEqual(cua._isMatrixDocumentRetryable(new Error('MATRIX_DOCUMENT_URL_REJECTED')), false);
  assert.strictEqual(cua._isMatrixDocumentRetryable(new Error('MATRIX_DOCUMENT_ACTION_MISSING')), false);
  assert.strictEqual(cua._isMatrixDocumentRetryable(new Error('MATRIX_DOCUMENT_PDF_TIMEOUT:wrapper=html')), true);
  assert.strictEqual(cua._isMatrixDocumentRetryable(new Error('ECONNRESET')), true);
  console.log('✅ Téléchargement PDF Matrix par navigation authentifiée validé');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
