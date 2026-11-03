/* NxtGen Analysis — Verify COA (talks to the COA app through the Shopify app proxy). */
(function () {
  'use strict';
  if (customElements.get('nga-verify')) return;

  var KEY_RE = /^(?:NGA)?([0-9A-HJKMNP-TV-Z]{12})$/;

  /** Mirrors the server's normalisation (case, spaces, O→0, I/L→1). */
  function normalizeKey(raw) {
    var s = String(raw || '').toUpperCase().replace(/[\s_-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    var m = KEY_RE.exec(s);
    if (!m) return null;
    var c = m[1];
    return 'NGA-' + c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8, 12);
  }

  function formatDate(value) {
    if (!value) return '';
    var iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T12:00:00Z' : value;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  class NgaVerify extends HTMLElement {
    connectedCallback() {
      this.endpoint = this.dataset.endpoint;
      this.form = this.querySelector('[data-form]');
      this.input = this.querySelector('[data-input]');
      this.inputError = this.querySelector('[data-input-error]');
      this.submit = this.querySelector('[data-submit]');
      this.result = this.querySelector('[data-result]');
      this.current = null;
      this.form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.lookup(this.input.value, true);
      });
      this.input.addEventListener('input', () => this.clearInputError());
      var initial = new URLSearchParams(window.location.search).get('key');
      if (initial) {
        this.input.value = initial;
        this.lookup(initial, false);
      }
    }

    tpl(name) {
      var t = this.querySelector('template[data-tpl="' + name + '"]');
      return t ? t.content.cloneNode(true) : document.createDocumentFragment();
    }

    show(fragment, focus) {
      this.result.replaceChildren(fragment);
      if (focus) this.result.focus({ preventScroll: false });
    }

    setBusy(busy) {
      this.submit.disabled = busy;
      this.submit.setAttribute('aria-busy', busy ? 'true' : 'false');
      this.result.setAttribute('aria-busy', busy ? 'true' : 'false');
    }

    clearInputError() {
      this.inputError.hidden = true;
      this.input.removeAttribute('aria-invalid');
      this.input.setAttribute('aria-describedby', this.input.getAttribute('aria-describedby').split(' ')[0]);
    }

    showInputError(msg) {
      this.inputError.textContent = msg;
      this.inputError.hidden = false;
      this.input.setAttribute('aria-invalid', 'true');
      this.input.setAttribute('aria-describedby', this.input.getAttribute('aria-describedby').split(' ')[0] + ' ' + this.inputError.id);
      this.input.focus();
    }

    updateUrl(key) {
      var url = new URL(window.location.href);
      if (key) url.searchParams.set('key', key);
      else url.searchParams.delete('key');
      window.history.replaceState({}, '', url.toString());
    }

    async lookup(raw, userInitiated) {
      this.clearInputError();
      if (!String(raw || '').trim()) {
        this.showInputError('Enter the verification key from your certificate.');
        return;
      }
      var key = normalizeKey(raw);
      if (!key) {
        this.showInputError('That does not look like a verification key. Keys look like NGA-XXXX-XXXX-XXXX.');
        return;
      }
      this.input.value = key;
      this.setBusy(true);
      this.show(this.tpl('loading'), false);
      var res;
      var body = {};
      try {
        res = await fetch(this.endpoint + '?key=' + encodeURIComponent(key), {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        });
        body = await res.json().catch(function () { return {}; });
      } catch (e) {
        res = null;
      }
      this.setBusy(false);
      if (res && res.ok && body.report) {
        this.updateUrl(key);
        this.renderReport(body.report, userInitiated);
        return;
      }
      if (res && res.status === 404) {
        this.updateUrl(key);
        var nf = this.tpl('not_found');
        var slot = nf.querySelector('[data-slot="key"]');
        if (slot) slot.textContent = key;
        this.show(nf, true);
        return;
      }
      if (res && res.status === 400) {
        this.result.replaceChildren();
        this.showInputError((body && body.message) || 'Check the verification key and try again.');
        return;
      }
      var err = this.tpl('error');
      if (res && res.status === 429) {
        var m = err.querySelector('[data-slot="message"]');
        if (m) m.textContent = (body && body.message) || 'Too many lookups. Please wait a minute and try again.';
      }
      var retry = err.querySelector('[data-retry]');
      if (retry) retry.addEventListener('click', () => this.lookup(key, true));
      this.show(err, true);
    }

    renderReport(r, focus) {
      this.current = r;
      var frag = this.tpl('found');
      var set = function (name, value) {
        var el = frag.querySelector('[data-slot="' + name + '"]');
        if (el) el.textContent = value || '—';
      };
      set('title', r.sampleName ? r.sampleName : r.testTypeName);
      set('testTypeName', r.testTypeName);
      set('sampleName', r.sampleName);
      set('lot', r.lot);
      set('reportNumber', r.reportNumber);
      set('reportDate', formatDate(r.reportDate));
      set('publishedAt', formatDate(r.publishedAt));
      set('verificationKey', r.verificationKey);
      ['lot', 'reportNumber', 'reportDate'].forEach(function (k) {
        if (!r[k]) frag.querySelectorAll('[data-row="' + k + '"]').forEach(function (el) { el.remove(); });
      });
      if (r.testData) {
        var b = frag.querySelector('[data-slot="test-badge"]');
        if (b) b.hidden = false;
      }
      var open = frag.querySelector('[data-slot="open"]');
      if (open && r.pages[0]) open.href = r.pages[0].url;
      var pages = frag.querySelector('[data-slot="pages"]');
      var total = r.pages.length;
      r.pages.forEach(function (p, i) {
        var fig = document.createElement('figure');
        fig.className = 'nga-page';
        var a = document.createElement('a');
        a.href = p.url;
        a.target = '_blank';
        a.rel = 'noopener';
        var img = document.createElement('img');
        img.src = p.url;
        img.width = p.width;
        img.height = p.height;
        img.loading = i === 0 ? 'eager' : 'lazy';
        img.decoding = 'async';
        img.alt = 'Certificate of Analysis' + (total > 1 ? ', page ' + (i + 1) + ' of ' + total : '') + ' — ' + (r.testTypeName || '');
        a.appendChild(img);
        var cap = document.createElement('figcaption');
        var label = document.createElement('span');
        label.textContent = total > 1 ? 'Page ' + (i + 1) + ' of ' + total : 'Certificate';
        var link = document.createElement('a');
        link.href = p.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Open image';
        cap.appendChild(label);
        cap.appendChild(link);
        fig.appendChild(a);
        fig.appendChild(cap);
        pages.appendChild(fig);
      });
      var dl = frag.querySelector('[data-download]');
      if (dl) {
        dl.textContent = total > 1 ? 'Download pages' : 'Download';
        dl.addEventListener('click', () => this.download(r));
      }
      var copy = frag.querySelector('[data-copy]');
      var status = frag.querySelector('[data-copy-status]');
      if (copy) copy.addEventListener('click', function () {
        var url = window.location.href;
        var done = function () { if (status) status.textContent = 'Link copied.'; };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(done, function () { if (status) status.textContent = url; });
        else if (status) status.textContent = url;
      });
      this.show(frag, focus);
    }

    async download(r) {
      for (var i = 0; i < r.pages.length; i++) {
        var p = r.pages[i];
        var name = r.verificationKey + (r.pages.length > 1 ? '-page-' + (i + 1) : '') + '.webp';
        try {
          // Works when the public asset domain allows CORS from the store; otherwise open the image.
          var res = await fetch(p.url, { mode: 'cors' });
          if (!res.ok) throw new Error('download failed');
          var blob = await res.blob();
          var href = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = href;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(href); }, 4000);
        } catch (e) {
          window.open(p.url, '_blank', 'noopener');
        }
      }
    }
  }

  customElements.define('nga-verify', NgaVerify);
})();
