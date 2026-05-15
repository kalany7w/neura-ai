/* Neura AI — Webchat Widget v1
 * Embed: <script async defer src=".../widget.js" data-neura-widget="<slug>" data-neura-api="<api-base>"></script>
 *
 * Vanilla JS — sem framework, sem dependências externas, ~15KB unminified.
 * Estado persistido em localStorage por slug. Polling 3s pra mensagens novas.
 */
(function () {
  'use strict';

  // Idempotência: se script já rodou (re-injeção via SPA navigation), abort.
  if (window.__neuraWebchatLoaded) return;
  window.__neuraWebchatLoaded = true;

  // ============================================
  // Config via data-attributes do <script>
  // ============================================
  var scriptTag =
    document.currentScript ||
    (function () {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        if (scripts[i].src && scripts[i].src.indexOf('widget.js') !== -1) return scripts[i];
      }
      return null;
    })();
  if (!scriptTag) {
    console.warn('[Neura] widget.js: script tag not found');
    return;
  }
  var widgetSlug = scriptTag.getAttribute('data-neura-widget');
  var apiBase = (scriptTag.getAttribute('data-neura-api') || '').replace(/\/$/, '');
  if (!widgetSlug || !apiBase) {
    console.warn('[Neura] widget.js: data-neura-widget e data-neura-api obrigatórios');
    return;
  }
  var LS_KEY = 'neura-webchat-session-' + widgetSlug;

  // ============================================
  // State
  // ============================================
  var state = {
    open: false,
    sessionToken: null,
    conversationId: null,
    messages: [], // { id, direction: 'INBOUND'|'OUTBOUND', content, createdAt }
    sending: false,
    config: {
      primaryColor: '#6366f1',
      title: 'Atendimento',
      placeholder: 'Digite sua mensagem…',
    },
    contactName: null,
    needsName: false,
    pollTimer: null,
    lastPollAt: null,
  };

  try {
    var saved = localStorage.getItem(LS_KEY);
    if (saved) {
      var parsed = JSON.parse(saved);
      state.sessionToken = parsed.sessionToken || null;
      state.contactName = parsed.contactName || null;
    }
  } catch (e) {
    /* ignore */
  }

  function persist() {
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({ sessionToken: state.sessionToken, contactName: state.contactName }),
      );
    } catch (e) {
      /* ignore */
    }
  }

  // ============================================
  // Network (fetch wrappers)
  // ============================================
  function api(path, opts) {
    opts = opts || {};
    return fetch(apiBase + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(
          function (b) {
            throw new Error(b.error || 'http_' + res.status);
          },
          function () {
            throw new Error('http_' + res.status);
          },
        );
      }
      return res.json();
    });
  }

  function bootstrapSession(opts) {
    opts = opts || {};
    var body = {};
    if (state.sessionToken) body.sessionToken = state.sessionToken;
    if (opts.name) body.name = opts.name;
    if (opts.email) body.email = opts.email;
    return api('/api/webchat/' + widgetSlug + '/session', {
      method: 'POST',
      body: body,
    }).then(function (res) {
      state.sessionToken = res.sessionToken;
      state.conversationId = res.conversationId;
      state.config = Object.assign(state.config, res.config || {});
      state.messages = (res.messages || []).map(function (m) {
        return {
          id: m.id,
          direction: m.direction,
          content: m.content || '',
          createdAt: m.createdAt,
        };
      });
      if (res.contact && res.contact.name) {
        state.contactName = res.contact.name;
      }
      // needsName=true se ainda não temos nome do contato
      state.needsName = !state.contactName;
      state.lastPollAt = state.messages.length > 0
        ? state.messages[state.messages.length - 1].createdAt
        : new Date().toISOString();
      persist();
      render();
      schedulePoll();
    });
  }

  function sendMessage(content) {
    state.sending = true;
    render();
    return api('/api/webchat/' + widgetSlug + '/messages', {
      method: 'POST',
      body: { sessionToken: state.sessionToken, content: content },
    })
      .then(function (res) {
        state.messages.push({
          id: res.messageId,
          direction: 'INBOUND', // do POV do servidor é INBOUND; aqui display "minha msg"
          content: content,
          createdAt: res.createdAt,
        });
        state.lastPollAt = res.createdAt;
      })
      .catch(function (err) {
        console.warn('[Neura] send failed', err);
        state.messages.push({
          id: 'err-' + Date.now(),
          direction: 'INBOUND',
          content: content,
          createdAt: new Date().toISOString(),
          failed: true,
        });
      })
      .then(function () {
        state.sending = false;
        render();
      });
  }

  function poll() {
    if (!state.sessionToken) return;
    var url =
      '/api/webchat/' +
      widgetSlug +
      '/poll?sessionToken=' +
      encodeURIComponent(state.sessionToken) +
      '&since=' +
      encodeURIComponent(state.lastPollAt || '');
    api(url)
      .then(function (res) {
        var newOnes = res.messages || [];
        if (newOnes.length > 0) {
          newOnes.forEach(function (m) {
            state.messages.push({
              id: m.id,
              direction: m.direction, // OUTBOUND = agente
              content: m.content || '',
              createdAt: m.createdAt,
            });
          });
          state.lastPollAt = newOnes[newOnes.length - 1].createdAt;
          render(true /* scrollToBottom */);
          // Pisca o botão se chat fechado
          if (!state.open) blinkBubble();
        }
      })
      .catch(function (err) {
        // 401 invalid_session → limpa state pra forçar re-bootstrap
        if (String(err.message).indexOf('invalid_session') !== -1) {
          state.sessionToken = null;
          state.conversationId = null;
          state.messages = [];
          persist();
          bootstrapSession();
        }
      });
  }

  function schedulePoll() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(poll, 3000);
  }

  // ============================================
  // UI
  // ============================================
  var STYLE_ID = 'neura-webchat-style';
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.neura-bubble{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;box-shadow:0 6px 24px rgba(0,0,0,0.18);cursor:pointer;z-index:2147483646;display:flex;align-items:center;justify-content:center;border:none;transition:transform 0.15s ease-out;color:#fff;font-family:system-ui,-apple-system,sans-serif;}' +
      '.neura-bubble:hover{transform:scale(1.05);}' +
      '.neura-bubble.blink{animation:neura-blink 1s ease-in-out 3;}' +
      '@keyframes neura-blink{0%,100%{transform:scale(1);box-shadow:0 6px 24px rgba(0,0,0,0.18);}50%{transform:scale(1.1);box-shadow:0 8px 32px rgba(99,102,241,0.5);}}' +
      '.neura-bubble svg{width:24px;height:24px;}' +
      '.neura-panel{position:fixed;bottom:88px;right:20px;width:360px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:14px;box-shadow:0 12px 48px rgba(0,0,0,0.22);z-index:2147483646;display:flex;flex-direction:column;font-family:system-ui,-apple-system,sans-serif;overflow:hidden;color:#111;}' +
      '.neura-panel[hidden]{display:none;}' +
      '.neura-header{padding:14px 16px;display:flex;align-items:center;justify-content:space-between;color:#fff;flex-shrink:0;}' +
      '.neura-header strong{font-size:14px;font-weight:600;}' +
      '.neura-header button{background:transparent;border:none;color:#fff;cursor:pointer;padding:4px;border-radius:4px;opacity:0.8;}' +
      '.neura-header button:hover{opacity:1;background:rgba(255,255,255,0.15);}' +
      '.neura-body{flex:1;overflow-y:auto;padding:16px;background:#f8f9fb;display:flex;flex-direction:column;gap:8px;}' +
      '.neura-msg{max-width:80%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;word-wrap:break-word;white-space:pre-wrap;}' +
      '.neura-msg.in{align-self:flex-end;background:#6366f1;color:#fff;border-bottom-right-radius:4px;}' +
      '.neura-msg.out{align-self:flex-start;background:#fff;color:#111;border:1px solid #e5e7eb;border-bottom-left-radius:4px;}' +
      '.neura-msg.failed{opacity:0.6;}' +
      '.neura-time{font-size:10px;opacity:0.6;margin-top:2px;display:block;}' +
      '.neura-empty{text-align:center;color:#9ca3af;font-size:13px;padding:32px 16px;}' +
      '.neura-form{display:flex;gap:6px;padding:10px;border-top:1px solid #e5e7eb;background:#fff;flex-shrink:0;}' +
      '.neura-input{flex:1;border:1px solid #d1d5db;border-radius:8px;padding:8px 12px;font-size:14px;outline:none;font-family:inherit;color:#111;}' +
      '.neura-input:focus{border-color:#6366f1;box-shadow:0 0 0 2px rgba(99,102,241,0.15);}' +
      '.neura-input:disabled{opacity:0.5;}' +
      '.neura-send{border:none;border-radius:8px;padding:0 14px;cursor:pointer;color:#fff;font-weight:500;font-size:14px;font-family:inherit;}' +
      '.neura-send:disabled{opacity:0.5;cursor:not-allowed;}' +
      '.neura-name-form{padding:20px;display:flex;flex-direction:column;gap:10px;background:#f8f9fb;flex:1;justify-content:center;}' +
      '.neura-name-form h4{margin:0 0 4px 0;font-size:15px;color:#111;}' +
      '.neura-name-form p{margin:0 0 12px 0;font-size:13px;color:#6b7280;}' +
      '.neura-footer{text-align:center;font-size:10px;color:#9ca3af;padding:6px;background:#fff;border-top:1px solid #f3f4f6;}' +
      '.neura-footer a{color:inherit;text-decoration:none;}' +
      '.neura-footer a:hover{text-decoration:underline;}';
    document.head.appendChild(style);
  }

  var container = null;
  var bubbleEl = null;
  var panelEl = null;
  var bodyEl = null;
  var inputEl = null;
  var sendBtnEl = null;

  function mount() {
    if (container) return;
    injectStyles();
    container = document.createElement('div');
    container.id = 'neura-webchat-root';
    document.body.appendChild(container);

    bubbleEl = document.createElement('button');
    bubbleEl.className = 'neura-bubble';
    bubbleEl.style.background = state.config.primaryColor;
    bubbleEl.setAttribute('aria-label', 'Abrir chat');
    bubbleEl.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    bubbleEl.addEventListener('click', toggleOpen);
    container.appendChild(bubbleEl);

    panelEl = document.createElement('div');
    panelEl.className = 'neura-panel';
    panelEl.hidden = true;
    container.appendChild(panelEl);
  }

  function renderPanel() {
    if (!panelEl) return;
    panelEl.style.color = '#111';
    var headerColor = state.config.primaryColor;

    var html =
      '<div class="neura-header" style="background:' +
      escapeAttr(headerColor) +
      ';">' +
      '<strong>' +
      escapeHtml(state.config.title || 'Atendimento') +
      '</strong>' +
      '<button type="button" data-neura-close aria-label="Fechar">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
      '</button>' +
      '</div>';

    if (state.needsName) {
      html +=
        '<form class="neura-name-form" data-neura-name-form>' +
        '<h4>Antes de começar</h4>' +
        '<p>Como podemos te chamar?</p>' +
        '<input class="neura-input" type="text" name="name" placeholder="Seu nome" required maxlength="80" />' +
        '<input class="neura-input" type="email" name="email" placeholder="Seu email (opcional)" maxlength="120" />' +
        '<button class="neura-send" type="submit" style="background:' +
        escapeAttr(headerColor) +
        ';padding:10px 14px;">Iniciar conversa</button>' +
        '</form>';
    } else {
      html += '<div class="neura-body" data-neura-body>';
      if (state.messages.length === 0) {
        html += '<div class="neura-empty">Envie a primeira mensagem.</div>';
      } else {
        state.messages.forEach(function (m) {
          var cls = m.direction === 'INBOUND' ? 'in' : 'out';
          if (m.failed) cls += ' failed';
          var bgStyle =
            m.direction === 'INBOUND'
              ? 'background:' + escapeAttr(headerColor) + ';'
              : '';
          html +=
            '<div class="neura-msg ' +
            cls +
            '" style="' +
            bgStyle +
            '">' +
            escapeHtml(m.content) +
            (m.failed ? '<span class="neura-time">não enviada — recarregue</span>' : '') +
            '</div>';
        });
      }
      html += '</div>';

      html +=
        '<form class="neura-form" data-neura-form>' +
        '<input class="neura-input" data-neura-input type="text" placeholder="' +
        escapeAttr(state.config.placeholder || 'Digite…') +
        '" maxlength="2000" ' +
        (state.sending ? 'disabled' : '') +
        ' />' +
        '<button class="neura-send" type="submit" style="background:' +
        escapeAttr(headerColor) +
        ';" ' +
        (state.sending ? 'disabled' : '') +
        '>' +
        (state.sending ? '…' : 'Enviar') +
        '</button>' +
        '</form>';
    }

    html +=
      '<div class="neura-footer">Powered by <a href="https://neura-ai.net" target="_blank" rel="noreferrer">Neura AI</a></div>';

    panelEl.innerHTML = html;

    var closeBtn = panelEl.querySelector('[data-neura-close]');
    if (closeBtn) closeBtn.addEventListener('click', toggleOpen);

    var form = panelEl.querySelector('[data-neura-form]');
    if (form) {
      inputEl = panelEl.querySelector('[data-neura-input]');
      sendBtnEl = panelEl.querySelector('.neura-send');
      bodyEl = panelEl.querySelector('[data-neura-body]');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = (inputEl.value || '').trim();
        if (!v || state.sending) return;
        inputEl.value = '';
        sendMessage(v);
      });
      setTimeout(function () {
        if (inputEl) inputEl.focus();
      }, 50);
    }

    var nameForm = panelEl.querySelector('[data-neura-name-form]');
    if (nameForm) {
      nameForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var name = nameForm.elements.name.value.trim();
        var email = nameForm.elements.email.value.trim();
        if (!name) return;
        state.contactName = name;
        bootstrapSession({ name: name, email: email || undefined });
      });
    }
  }

  function render(scrollToBottom) {
    if (!container) return;
    bubbleEl.style.background = state.config.primaryColor;
    if (state.open) {
      panelEl.hidden = false;
      bubbleEl.style.display = 'none';
      renderPanel();
      if (scrollToBottom) {
        // após render, scroll pra última msg
        setTimeout(function () {
          var b = panelEl.querySelector('[data-neura-body]');
          if (b) b.scrollTop = b.scrollHeight;
        }, 10);
      }
    } else {
      panelEl.hidden = true;
      bubbleEl.style.display = 'flex';
    }
  }

  function toggleOpen() {
    state.open = !state.open;
    render(true);
  }

  function blinkBubble() {
    if (!bubbleEl) return;
    bubbleEl.classList.add('blink');
    setTimeout(function () {
      if (bubbleEl) bubbleEl.classList.remove('blink');
    }, 3000);
  }

  // ============================================
  // Escape helpers
  // ============================================
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ============================================
  // Boot
  // ============================================
  function boot() {
    mount();
    render();
    bootstrapSession()
      .then(function () {
        render();
      })
      .catch(function (err) {
        console.warn('[Neura] bootstrap failed', err);
        if (panelEl) {
          panelEl.innerHTML =
            '<div style="padding:24px;text-align:center;color:#9ca3af;font-size:13px;">Chat temporariamente indisponível.</div>';
        }
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
