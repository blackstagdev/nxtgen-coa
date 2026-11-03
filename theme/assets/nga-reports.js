/* NxtGen Analysis — customer Test Reports list (via the Shopify app proxy). */
(function () {
  'use strict';
  if (customElements.get('nga-reports')) return;

  function formatDate(value) {
    if (!value) return '—';
    var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T12:00:00Z' : value);
    return isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  class NgaReports extends HTMLElement {
    connectedCallback() {
      this.endpoint = this.dataset.endpoint;
      this.verifyUrl = this.dataset.verifyUrl;
      this.form = this.querySelector('[data-form]');
      this.q = this.querySelector('[data-q]');
      this.type = this.querySelector('[data-type]');
      this.results = this.querySelector('[data-results]');
      this.count = this.querySelector('[data-count]');
      var params = new URLSearchParams(window.location.search);
      this.state = { q: params.get('q') || '', type: params.get('type') || '', page: Math.max(1, parseInt(params.get('page') || '1', 10) || 1) };
      this.q.value = this.state.q;
      this.form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.state = { q: this.q.value.trim(), type: this.type.value, page: 1 };
        this.load(true);
      });
      this.type.addEventListener('change', () => {
        this.state = { q: this.q.value.trim(), type: this.type.value, page: 1 };
        this.load(true);
      });
      this.loadTypes();
      this.load(false);
    }

    tpl(name) {
      var t = this.querySelector('template[data-tpl="' + name + '"]');
      return t ? t.content.cloneNode(true) : document.createDocumentFragment();
    }

    async loadTypes() {
      try {
        var res = await fetch(this.dataset.typesEndpoint, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (!res.ok) return;
        var body = await res.json();
        (body.testTypes || []).forEach((t) => {
          var o = el('option', { value: t.slug }, t.name);
          if (t.slug === this.state.type) o.selected = true;
          this.type.appendChild(o);
        });
      } catch (e) { /* filter stays usable with "All" */ }
    }

    syncUrl() {
      var url = new URL(window.location.href);
      ['q', 'type'].forEach((k) => { if (this.state[k]) url.searchParams.set(k, this.state[k]); else url.searchParams.delete(k); });
      if (this.state.page > 1) url.searchParams.set('page', String(this.state.page)); else url.searchParams.delete('page');
      window.history.replaceState({}, '', url.toString());
    }

    async load(focus) {
      this.results.setAttribute('aria-busy', 'true');
      this.results.style.opacity = '0.55';
      this.syncUrl();
      var qs = new URLSearchParams({ q: this.state.q, type: this.state.type, page: String(this.state.page) });
      var res = null;
      var body = {};
      try {
        res = await fetch(this.endpoint + '?' + qs.toString(), { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        body = await res.json().catch(function () { return {}; });
      } catch (e) { res = null; }
      this.results.style.opacity = '';
      this.results.setAttribute('aria-busy', 'false');
      if (!res || !res.ok) {
        var err = this.tpl('error');
        var msg = err.querySelector('[data-slot="message"]');
        if (msg && body && body.message) msg.textContent = body.message;
        if (res && res.status === 401) {
          if (msg) msg.textContent = 'Your session has ended. Please sign in again.';
        }
        err.querySelector('[data-retry]').addEventListener('click', () => this.load(true));
        this.count.textContent = '';
        this.results.replaceChildren(err);
        return;
      }
      this.render(body, focus);
    }

    render(body, focus) {
      var filtered = !!(this.state.q || this.state.type);
      if (!body.total) {
        this.count.textContent = '';
        var t = this.tpl(filtered ? 'no_match' : 'empty');
        var clear = t.querySelector('[data-clear]');
        if (clear) clear.addEventListener('click', () => {
          this.q.value = '';
          this.type.value = '';
          this.state = { q: '', type: '', page: 1 };
          this.load(true);
        });
        this.results.replaceChildren(t);
        return;
      }
      this.count.textContent = body.total + (body.total === 1 ? ' report' : ' reports') + (filtered ? ' match your filters' : '');
      var table = el('table', { class: 'nga-table' });
      table.appendChild(el('caption', { class: 'visually-hidden' }, 'Your published Certificates of Analysis'));
      var thead = el('thead');
      var hr = el('tr');
      ['Sample', 'Test', 'Report date', 'Verification key', 'Actions'].forEach(function (h) {
        var th = el('th', { scope: 'col' }, h === 'Actions' ? '' : h);
        if (h === 'Actions') th.appendChild(el('span', { class: 'visually-hidden' }, 'Actions'));
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = el('tbody');
      body.reports.forEach((r) => {
        var tr = el('tr');
        var c1 = el('td', { class: 'nga-table__primary', 'data-label': 'Sample' });
        c1.appendChild(el('span', { class: 'nga-table__sample' }, r.sampleName || 'Untitled sample'));
        if (r.lot) c1.appendChild(el('span', { class: 'nga-table__sub' }, 'Lot ' + r.lot));
        if (r.testData) c1.appendChild(el('span', { class: 'nga-badge nga-badge--test' }, 'Test data'));
        tr.appendChild(c1);
        tr.appendChild(el('td', { 'data-label': 'Test' }, r.testTypeName));
        tr.appendChild(el('td', { 'data-label': 'Report date' }, formatDate(r.reportDate || r.publishedAt)));
        tr.appendChild(el('td', { 'data-label': 'Key', class: 'nga-mono' }, r.verificationKey));
        var actions = el('td', { 'data-label': 'Actions' });
        var wrap = el('span', { class: 'nga-table__actions' });
        var view = el('a', { class: 'nga-link-btn', href: this.verifyUrl + '?key=' + encodeURIComponent(r.verificationKey) }, 'View');
        view.appendChild(el('span', { class: 'visually-hidden' }, ' report for ' + (r.sampleName || r.verificationKey)));
        wrap.appendChild(view);
        if (r.pages && r.pages[0]) {
          var img = el('a', { class: 'nga-link-btn', href: r.pages[0].url, target: '_blank', rel: 'noopener' }, 'Image');
          img.appendChild(el('span', { class: 'visually-hidden' }, ' (opens in a new tab)'));
          wrap.appendChild(img);
        }
        actions.appendChild(wrap);
        tr.appendChild(actions);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      var frag = document.createDocumentFragment();
      frag.appendChild(table);
      if (body.pages > 1) {
        var pager = el('nav', { class: 'nga-pager', 'aria-label': 'Report pages' });
        pager.appendChild(el('span', null, 'Page ' + body.page + ' of ' + body.pages));
        var btns = el('div');
        if (body.page > 1) {
          var prev = el('button', { type: 'button', class: 'nga-link-btn' }, 'Previous');
          prev.addEventListener('click', () => { this.state.page = body.page - 1; this.load(true); });
          btns.appendChild(prev);
        }
        if (body.page < body.pages) {
          var next = el('button', { type: 'button', class: 'nga-link-btn' }, 'Next');
          next.addEventListener('click', () => { this.state.page = body.page + 1; this.load(true); });
          btns.appendChild(next);
        }
        pager.appendChild(btns);
        frag.appendChild(pager);
      }
      this.results.replaceChildren(frag);
      if (focus) {
        this.count.setAttribute('tabindex', '-1');
        this.count.focus();
      }
    }
  }

  customElements.define('nga-reports', NgaReports);
})();
