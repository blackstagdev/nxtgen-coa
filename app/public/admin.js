/* NxtGen Analysis COA console — progressive enhancement only (forms work without JS
   except image uploads, which need it). No inline scripts: CSP is script-src 'self'. */
(function () {
  'use strict';
  var csrfInput = document.querySelector('input[name="_csrf"]');
  var CSRF = csrfInput ? csrfInput.value : '';

  // Confirm destructive / public actions
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Focus error summary
  var auto = document.querySelector('[data-autofocus]');
  if (auto) auto.focus();

  // Unsaved-changes guard
  var guarded = document.querySelector('form[data-dirty-guard]');
  if (guarded) {
    var dirty = false;
    var indicator = guarded.querySelector('[data-dirty-indicator]');
    var mark = function () {
      dirty = true;
      if (indicator) indicator.hidden = false;
    };
    guarded.addEventListener('input', mark);
    guarded.addEventListener('change', mark);
    guarded.addEventListener('submit', function () { dirty = false; });
    window.addEventListener('beforeunload', function (e) {
      if (dirty) { e.preventDefault(); e.returnValue = ''; }
    });
    guarded.__markDirty = mark;
  }

  // Image uploads
  document.querySelectorAll('[data-upload]').forEach(function (zone) {
    var input = zone.querySelector('[data-input]');
    var list = zone.querySelector('[data-list]');
    var status = zone.querySelector('[data-status]');
    var field = zone.getAttribute('data-field-key');
    var report = zone.getAttribute('data-report');
    var max = parseInt(zone.getAttribute('data-max') || '1', 10);
    if (!input) return;

    function setStatus(msg, isError) {
      if (!status) return;
      status.textContent = msg || '';
      status.className = 'upload__status' + (isError ? ' upload__status--error' : '');
    }
    function count() { return list.querySelectorAll('[data-item]').length; }
    function bindRemove(item) {
      var btn = item.querySelector('[data-remove]');
      if (btn) btn.addEventListener('click', function () {
        item.remove();
        setStatus('Image removed. Save the draft to apply.');
        if (guarded && guarded.__markDirty) guarded.__markDirty();
      });
    }
    list.querySelectorAll('[data-item]').forEach(bindRemove);

    function addItem(id, url) {
      if (max === 1) list.innerHTML = '';
      var item = document.createElement('div');
      item.className = 'upload__item';
      item.setAttribute('data-item', '');
      var img = document.createElement('img');
      img.src = url;
      img.alt = 'Uploaded image';
      var hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'f[' + field + '][]';
      hidden.value = id;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-remove', '');
      btn.textContent = 'Remove';
      item.appendChild(img);
      item.appendChild(hidden);
      item.appendChild(btn);
      list.appendChild(item);
      bindRemove(item);
      if (guarded && guarded.__markDirty) guarded.__markDirty();
    }

    function upload(file) {
      if (!file) return;
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setStatus('Only PNG, JPEG or WEBP images are accepted.', true); return; }
      if (max > 1 && count() >= max) { setStatus('Remove an image first (maximum ' + max + ').', true); return; }
      var fd = new FormData();
      fd.append('field', field);
      fd.append('file', file, file.name);
      setStatus('Uploading ' + file.name + '…');
      zone.setAttribute('aria-busy', 'true');
      fetch('/admin/reports/' + report + '/uploads', {
        method: 'POST',
        headers: { 'X-CSRF-Token': CSRF, Accept: 'application/json' },
        body: fd,
        credentials: 'same-origin'
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, body: body }; });
        })
        .then(function (r) {
          if (!r.ok) throw new Error((r.body && r.body.message) || 'Upload failed.');
          addItem(r.body.id, r.body.url);
          setStatus('Uploaded (' + r.body.width + '×' + r.body.height + '). Save the draft to keep it.');
        })
        .catch(function (err) { setStatus(err.message || 'Upload failed. Try again.', true); })
        .finally(function () { zone.removeAttribute('aria-busy'); input.value = ''; });
    }

    input.addEventListener('change', function () {
      Array.prototype.slice.call(input.files || [], 0, max).forEach(upload);
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('upload--drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('upload--drag'); });
    });
    zone.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files) Array.prototype.slice.call(files, 0, max).forEach(upload);
    });
  });
})();
