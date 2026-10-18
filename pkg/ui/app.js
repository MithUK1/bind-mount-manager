/*
 * Bind Mount Manager - browser UI
 *
 * Talks to two back ends:
 *   - api.cgi, this package's own CGI (mount list, folder browser, helper status)
 *   - DSM's web API, used only for one-time setup actions that need an
 *     administrator (creating a shared folder, creating the boot-up task)
 *
 * Everything is built with textContent / DOM nodes. Nothing is ever inserted
 * as HTML.
 */
(function () {
  'use strict';

  var API = 'api.cgi';
  var TASK_NAME = 'Bind Mount Manager';
  var SETUP_CMD = '/bin/bash /var/packages/BindMountManager/target/bin/install-helper.sh';
  var UPDATE_CMD = SETUP_CMD + ' --force';
  var POLL_MS = 4000;
  var POLL_MS_NO_HELPER = 2500;

  var token = '';          // DSM CSRF token (SynoToken)
  var status = null;       // last good reply from api.cgi?action=status
  var loadError = '';
  var confirmId = null;    // mount id waiting for a second click on Remove
  var busy = {};           // mount ids with a change in flight
  var dlg = null;          // add dialog state
  var pollTimer = null;
  var bootTask = 'unknown'; // is the boot-up task in Task Scheduler? 'yes' | 'no' | 'unknown'
  var bootChecked = false;
  var setup = { busy: false, step: '', error: '', pw: '', manualOpen: false };

  // ---------- DOM helper ----------
  function h(tag, props) {
    var el = document.createElement(tag);
    var kids = [];
    var i, k;
    if (props) {
      for (k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        var v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
        else if (k === 'disabled' || k === 'checked' || k === 'value') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (i = 2; i < arguments.length; i++) kids.push(arguments[i]);
    (function append(list) {
      list.forEach(function (kid) {
        if (kid === null || kid === undefined || kid === false) return;
        if (Array.isArray(kid)) { append(kid); return; }
        el.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
      });
    })(kids);
    return el;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---------- package API (api.cgi) ----------
  function initToken() {
    var fromUrl = new URLSearchParams(location.search).get('SynoToken');
    if (fromUrl) { token = fromUrl; return Promise.resolve(); }
    return fetch('/webman/login.cgi', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) { token = (j && j.SynoToken) || ''; })
      .catch(function () { token = ''; });
  }

  function api(action, params, method) {
    var qs = new URLSearchParams({ action: action, SynoToken: token });
    var opts = {
      credentials: 'same-origin',
      headers: { 'X-SYNO-TOKEN': token, 'X-Requested-With': 'bmm' }
    };
    if (method === 'POST') {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(params || {}).toString();
    } else {
      Object.keys(params || {}).forEach(function (k) { qs.set(k, params[k]); });
    }
    return fetch(API + '?' + qs.toString(), opts).then(function (r) {
      return r.json().then(function (j) { return j; }, function () {
        throw new Error('Unexpected reply from the server (HTTP ' + r.status + ')');
      });
    }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'Request failed');
      return j;
    });
  }

  // ---------- DSM web API (runs as the signed-in administrator) ----------
  // jsonValues: true when the API expects every value JSON-encoded, false when
  // values are sent as plain strings.
  function dsmCall(apiName, method, version, params, jsonValues) {
    var body = new URLSearchParams({ api: apiName, method: method, version: String(version) });
    Object.keys(params || {}).forEach(function (k) {
      body.set(k, jsonValues ? JSON.stringify(params[k]) : String(params[k]));
    });
    var headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (token) headers['X-SYNO-TOKEN'] = token;
    return fetch('/webapi/entry.cgi', { method: 'POST', credentials: 'same-origin', headers: headers, body: body.toString() })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.success) {
          var code = j && j.error ? j.error.code : 'unknown';
          var detail = j && j.error && j.error.errors ? ' ' + JSON.stringify(j.error.errors) : '';
          throw new Error('DSM refused ' + apiName.replace('SYNO.Core.', '') + ' ' + method + ' (error ' + code + detail + ').');
        }
        return j.data;
      });
  }

  function apiInfo(name) {
    return fetch('/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=' + encodeURIComponent(name), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) { return (j && j.success && j.data && j.data[name]) || {}; })
      .catch(function () { return {}; });
  }

  function requireHttps(what) {
    if (location.protocol === 'https:') return Promise.resolve();
    return Promise.reject(new Error(what + ' needs DSM opened over https://. Open DSM with https:// and try again.'));
  }

  // DSM asks for the administrator's password before it changes root tasks or
  // creates shared folders, exactly like its own Control Panel does.
  function confirmToken(pw) {
    return requireHttps('Confirming your password').then(function () {
      return apiInfo('SYNO.Core.User.PasswordConfirm');
    }).then(function (info) {
      return dsmCall('SYNO.Core.User.PasswordConfirm', 'auth', info.maxVersion || 1, { password: pw }, false);
    }).then(function (d) {
      if (!d || !d.SynoConfirmPWToken) throw new Error('DSM did not accept that password.');
      return d.SynoConfirmPWToken;
    });
  }

  // Creates a real DSM shared folder (only those can be SMB shares)
  function createShare(name, volPath) {
    return requireHttps('Creating the share').then(function () {
      return apiInfo('SYNO.Core.Share');
    }).then(function (info) {
      var version = info.maxVersion || 1;
      var shareinfo = {
        name: name, vol_path: volPath, desc: 'Created by Bind Mount Manager', name_org: '',
        enable_recycle_bin: true, recycle_bin_admin_only: true
      };
      if (info.requestFormat === 'JSON') {
        return dsmCall('SYNO.Core.Share', 'create', version, { name: name, shareinfo: shareinfo }, true);
      }
      return dsmCall('SYNO.Core.Share', 'create', version, { name: name, shareinfo: JSON.stringify(shareinfo) }, false);
    });
  }

  function listTasks() {
    var attempts = [
      { sort_by: 'next_trigger_time', sort_direction: 'ASC', offset: 0, limit: 100 },
      { offset: 0, limit: 100 }
    ];
    function attempt(i) {
      return dsmCall('SYNO.Core.TaskScheduler', 'list', 1, attempts[i], true).catch(function (e) {
        if (i + 1 < attempts.length) return attempt(i + 1);
        throw e;
      });
    }
    return attempt(0);
  }

  function findTask() {
    return listTasks().then(function (d) {
      var list = (d && (d.tasks || d.task)) || [];
      for (var i = 0; i < list.length; i++) if (list[i].name === TASK_NAME) return list[i];
      return null;
    });
  }

  function saveTask(method, tok, command) {
    return dsmCall('SYNO.Core.EventScheduler.Root', method, 1, {
      task_name: TASK_NAME,
      owner: JSON.stringify({ '0': 'root' }),
      event: 'bootup',
      depend_on_task: '',
      enable: 'true',
      notify_enable: 'false',
      notify_mail: '""',
      notify_if_error: 'false',
      operation: command,
      operation_type: 'script',
      SynoConfirmPWToken: tok
    }, false);
  }

  function createTask(pw) {
    return confirmToken(pw).then(function (tok) { return saveTask('create', tok, SETUP_CMD); });
  }

  function runTask() {
    return dsmCall('SYNO.Core.EventScheduler', 'run', 1, { task_name: TASK_NAME }, false);
  }

  // Opens a Control Panel page in a new browser tab using DSM's launchApp link
  function openDsmPage(fn) {
    var url = '/?launchApp=SYNO.SDS.AdminCenter.Application&launchParam=' + encodeURIComponent('fn=' + fn);
    var w = null;
    try { w = window.open(url, '_blank'); } catch (e) { w = null; }
    if (!w && dlg) { dlg.error = 'Your browser blocked the new tab. In DSM, open Control Panel.'; renderDialog(); }
  }
  function openSharedFolders() { openDsmPage('SYNO.SDS.AdminCenter.Share.Main'); }
  function openTaskScheduler() { openDsmPage('SYNO.SDS.AdminCenter.TaskScheduler.Main'); }

  // ---------- helper status ----------
  function helperAlive() { return !!(status && status.helper.alive); }
  function helperOutdated() { return helperAlive() && status.helper.version !== status.helper.expected; }
  function canAdd() { return helperAlive() && !helperOutdated(); }

  // Refreshes the status until the helper is up (and, if asked, current)
  function waitForHelper(tries, mustBeCurrent) {
    return new Promise(function (resolve) {
      var i = 0;
      (function tick() {
        refresh().then(function () {
          if (helperAlive() && (!mustBeCurrent || !helperOutdated())) { resolve(true); return; }
          i += 1;
          if (i >= tries) { resolve(false); return; }
          setTimeout(tick, 1500);
        });
      })();
    });
  }

  // ---------- one-time setup and helper updates ----------
  function setStep(text) { setup.step = text; render(); }

  function finishSetup(error) {
    setup.busy = false;
    setup.step = '';
    setup.pw = '';
    setup.error = error || '';
    render();
  }

  // Runs work(password) with the shared busy / error handling. work() resolves
  // with an error message for soft failures, or nothing on success.
  function withPassword(firstStep, work) {
    if (!setup.pw) {
      setup.error = 'Type your DSM password first. It is only sent to DSM to confirm the change and is never stored.';
      render();
      return;
    }
    setup.busy = true;
    setup.error = '';
    setStep(firstStep);
    work(setup.pw).then(finishSetup, function (e) { finishSetup(e.message); });
  }

  function autoSetup() {
    withPassword('Confirming your password...', function (pw) {
      return findTask().catch(function () { return null; }).then(function (existing) {
        if (existing) return null;
        setStep('Creating the boot-up task...');
        return createTask(pw);
      }).then(function () {
        setStep('Starting the helper...');
        return runTask();
      }).then(function () {
        return waitForHelper(14, false);
      }).then(function (alive) {
        return alive ? '' : 'The task was created, but the helper did not start yet. In Task Scheduler, select "' + TASK_NAME + '" and click Run.';
      });
    });
  }

  function createBootTask() {
    withPassword('Creating the boot-up task...', function (pw) {
      return createTask(pw).then(findTask).then(function (t) {
        bootTask = t ? 'yes' : 'no';
        return '';
      });
    });
  }

  // Switches the boot-up task to "--force" so it replaces the installed helper,
  // runs it, then puts the normal command back.
  function updateHelper() {
    withPassword('Confirming your password...', function (pw) {
      var updated = false;
      return confirmToken(pw).then(function (tok) {
        setStep('Updating the helper...');
        return saveTask('set', tok, UPDATE_CMD);
      }).then(runTask).then(function () {
        return waitForHelper(14, true);
      }).then(function (ok) {
        updated = ok;
        setStep('Tidying up...');
        return confirmToken(pw).then(function (tok) { return saveTask('set', tok, SETUP_CMD); }).catch(function () {});
      }).then(function () {
        return updated ? '' : 'The helper did not update yet. Click Check again in a minute.';
      });
    });
  }

  function submitPassword() {
    if (helperOutdated()) updateHelper();
    else if (helperAlive()) createBootTask();
    else autoSetup();
  }

  function checkBootTask() {
    if (!helperAlive() || bootChecked) return;
    bootChecked = true;
    findTask().then(function (t) { bootTask = t ? 'yes' : 'no'; render(); },
                    function () { bootTask = 'unknown'; });
  }

  // ---------- clipboard ----------
  function copyText(text, btn) {
    function done(okay) {
      var old = btn.textContent;
      btn.textContent = okay ? 'Copied' : 'Press Ctrl+C';
      setTimeout(function () { btn.textContent = old; }, 1600);
    }
    function legacyCopy() {
      var ta = h('textarea', { style: 'position:fixed;left:-1000px;top:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      var okay = false;
      try { okay = document.execCommand('copy'); } catch (e) { okay = false; }
      document.body.removeChild(ta);
      done(okay);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, legacyCopy);
    } else {
      legacyCopy();
    }
  }

  function codeBox(text) {
    var btn = h('button', { text: 'Copy' });
    btn.addEventListener('click', function () { copyText(text, btn); });
    return h('div', { class: 'codebox' }, h('code', { text: text }), btn);
  }

  function taskBtn() {
    return h('button', { class: 'linkbtn strong', text: 'Open Task Scheduler in a new tab', onclick: openTaskScheduler });
  }

  function shareBtn() {
    return h('button', { class: 'linkbtn strong', text: 'Open Shared Folder in a new tab', onclick: openSharedFolders });
  }

  // ---------- main page ----------
  var STATE_LABEL = {
    mounted: ['Active', 'ok'],
    disabled: ['Off', 'off'],
    waiting: ['Waiting', 'warn'],
    error: ['Problem', 'bad'],
    pending: ['Applying', 'warn'],
    unknown: ['Not applied', 'warn']
  };

  function pill(state) {
    var s = STATE_LABEL[state] || STATE_LABEL.unknown;
    return h('span', { class: 'pill ' + s[1], text: s[0] });
  }

  function helperPill() {
    if (!status) return h('span', { class: 'pill off', text: 'Connecting' });
    if (status.helper.alive) return h('span', { class: 'pill ok', text: 'Helper running' });
    return h('span', { class: 'pill warn', text: 'Setup needed' });
  }

  function header() {
    return h('header', { class: 'top' },
      h('div', { class: 'title-wrap' },
        h('h1', { text: 'Bind Mount Manager' }),
        h('p', { text: 'Show a folder as its own share, and keep it working after reboots.' })),
      helperPill(),
      h('button', { class: 'primary', text: 'Add mount', disabled: !canAdd(), title: canAdd() ? '' : 'Set up or update the helper first', onclick: openAdd }));
  }

  function pwField() {
    return h('input', {
      type: 'password', class: 'pwin', placeholder: 'Your DSM password', autocomplete: 'current-password',
      value: setup.pw, oninput: function (e) { setup.pw = e.target.value; },
      onkeydown: function (e) { if (e.key === 'Enter') submitPassword(); }
    });
  }

  function manualSteps() {
    return h('div', null,
      h('h3', { text: 'In DSM' }),
      h('ol', null,
        h('li', null, 'Open Control Panel > Task Scheduler > Create > Triggered Task > User-defined script. ', taskBtn()),
        h('li', null, 'General tab:',
          h('ul', null,
            h('li', { text: 'Task: ' + TASK_NAME }),
            h('li', { text: 'User: root' }),
            h('li', { text: 'Event: Boot-up' }),
            h('li', { text: 'Enabled: ticked' }))),
        h('li', null, 'Task Settings tab, Run command > User-defined script, paste this:', codeBox(SETUP_CMD)),
        h('li', { text: 'Click OK and accept the warning.' }),
        h('li', { text: 'Select the new task in the list and click Run.' })));
  }

  function setupCard() {
    if (!status || status.helper.alive) return null;
    var details = h('details', {
      open: (setup.manualOpen || !!setup.error) ? true : null,
      ontoggle: function (ev) { setup.manualOpen = ev.target.open; }
    }, h('summary', { text: 'Manual install' }), manualSteps());
    return h('section', { class: 'card setup' },
      h('h2', { text: 'One-time setup' }),
      h('p', { text: 'DSM does not let apps mount folders by themselves. A small helper has to run as root, so a boot-up task is needed in Task Scheduler. Type your DSM password to confirm and the app creates it for you.' }),
      h('div', { class: 'actions left' }, pwField(),
        h('button', { class: 'primary big', text: setup.busy ? 'Setting up...' : 'Set up automatically', disabled: setup.busy, onclick: autoSetup }),
        h('button', { text: 'Check again', disabled: setup.busy, onclick: refresh })),
      setup.step ? h('p', { class: 'muted', text: setup.step }) : null,
      setup.error ? h('div', { class: 'errbox' }, h('strong', { text: 'That did not work. ' }), setup.error + ' You can use Manual install below.') : null,
      details,
      h('p', { class: 'muted small', text: 'The helper checks everything it is asked to do, only works inside your /volume folders and never touches system folders.' }));
  }

  function bootBanner() {
    if (!helperAlive() || bootTask !== 'no') return null;
    return h('div', { class: 'banner' },
      h('strong', { text: 'Almost done. ' }),
      'The helper is running, but there is no boot-up task for it, so it would not start again after a reboot.',
      h('div', { class: 'actions left' }, pwField(),
        h('button', { class: 'primary', text: setup.busy ? 'Creating...' : 'Create boot-up task', disabled: setup.busy, onclick: createBootTask })),
      setup.error ? h('div', { class: 'errbox', text: setup.error + ' You can use Manual install instead:' }) : null,
      setup.error ? manualSteps() : null);
  }

  function updateBanner() {
    if (!helperOutdated()) return null;
    return h('div', { class: 'banner' },
      h('strong', { text: 'The helper needs updating. ' }),
      'Type your DSM password and the app updates it for you. Add mount is locked until then.',
      h('div', { class: 'actions left' }, pwField(),
        h('button', { class: 'primary', text: setup.busy ? 'Updating...' : 'Update helper', disabled: setup.busy, onclick: updateHelper })),
      setup.step ? h('p', { class: 'muted', text: setup.step }) : null,
      setup.error ? h('div', { class: 'errbox', text: setup.error }) : null);
  }

  function pathLine(label, path) {
    return h('div', { class: 'pathline' }, h('span', { class: 'lbl', text: label }), h('code', { text: path }));
  }

  function mountCard(m) {
    var name = m.target.split('/').pop();
    var armed = confirmId === m.id;
    var isShare = m.target.split('/').length === 3;   // /volumeN/name is a shared folder
    var sw = h('input', { type: 'checkbox', checked: m.enabled, disabled: !!busy[m.id], 'aria-label': 'Turn this mount on or off' });
    sw.addEventListener('change', function () { toggle(m, sw.checked); });
    var plainActive = m.state === 'mounted' && (m.message === 'Active' || m.message === 'Active (read only)');
    return h('section', { class: 'card mount ' + m.state },
      h('div', { class: 'mount-main' },
        h('div', { class: 'mount-title' },
          h('strong', { text: name }),
          pill(m.state),
          m.ro ? h('span', { class: 'tag', text: 'Read only' }) : null),
        h('div', { class: 'paths' },
          pathLine('Source', m.source),
          pathLine('Shows at', m.target)),
        m.message && !plainActive ? h('div', { class: 'msg', text: m.message }) : null),
      h('div', { class: 'mount-actions' },
        h('label', { class: 'switch' }, sw, h('span', { class: 'track' })),
        h('div', { class: 'btnrow' },
          isShare ? h('button', {
            class: 'permbtn', text: 'Permissions',
            title: 'Opens Shared Folder in a new tab. Select "' + name + '", click Edit, then the Permissions tab.',
            onclick: openSharedFolders
          }) : null,
          h('button', {
            class: 'danger' + (armed ? ' armed' : ''),
            text: armed ? 'Click again to remove' : 'Remove',
            disabled: !!busy[m.id],
            onclick: function () { removeMount(m); }
          }))));
  }

  function listSection() {
    if (!status) {
      return loadError
        ? h('div', { class: 'card' }, h('h2', { text: 'Could not load' }), h('p', { class: 'muted', text: loadError }), h('button', { text: 'Try again', onclick: refresh }))
        : null;
    }
    if (status.mounts.length) return h('div', null, status.mounts.map(mountCard));
    if (!status.helper.alive) return null;
    return h('section', { class: 'card empty' },
      h('h2', { text: 'No bind mounts yet' }),
      h('p', { text: 'A bind mount makes a folder that already has files show up as its own share, without moving or copying anything. For example, make /volume2/data/media/tv also appear as \\\\NAS\\tv.' }),
      h('button', { class: 'primary big', text: 'Add your first mount', disabled: !canAdd(), title: canAdd() ? '' : 'Update the helper first', onclick: openAdd }));
  }

  function footer() {
    return h('footer', { class: 'foot', text: status
      ? 'Bind Mount Manager ' + status.version + (status.helper.alive ? '  |  helper ' + status.helper.version : '')
      : 'Bind Mount Manager' });
  }

  function render() {
    var app = document.getElementById('app');
    var active = document.activeElement;
    var typing = !!(active && active.classList && active.classList.contains('pwin'));
    var caret = typing ? active.selectionStart : 0;
    clear(app);
    [header(),
      loadError && status ? h('div', { class: 'banner', text: loadError }) : null,
      setupCard(), bootBanner(), updateBanner(), listSection(), footer()
    ].forEach(function (n) { if (n) app.appendChild(n); });
    if (typing) {
      var input = app.querySelector('.pwin');
      if (input) { input.focus(); try { input.setSelectionRange(caret, caret); } catch (e) { /* not supported */ } }
    }
  }

  // ---------- mount actions ----------
  function refresh() {
    return api('status').then(function (j) {
      status = j;
      loadError = '';
      render();
      checkBootTask();
    }).catch(function (e) {
      loadError = e.message;
      render();
    });
  }

  function toggle(m, on) {
    busy[m.id] = true;
    api('toggle', { id: m.id, enabled: on ? '1' : '0' }, 'POST').then(function () {
      m.enabled = on;
      m.state = 'pending';
      m.message = 'Applying';
      render();
      setTimeout(function () { delete busy[m.id]; refresh(); }, 2500);
    }).catch(function (e) {
      delete busy[m.id];
      loadError = e.message;
      refresh();
    });
    render();
  }

  function removeMount(m) {
    if (confirmId !== m.id) {
      confirmId = m.id;
      render();
      setTimeout(function () { if (confirmId === m.id) { confirmId = null; render(); } }, 4000);
      return;
    }
    confirmId = null;
    busy[m.id] = true;
    render();
    api('remove', { id: m.id }, 'POST').then(function () {
      setTimeout(function () { delete busy[m.id]; refresh(); }, 1500);
    }).catch(function (e) {
      delete busy[m.id];
      loadError = e.message;
      refresh();
    });
  }

  // ---------- add dialog ----------
  function openAdd() {
    if (!canAdd()) return;
    dlg = { source: '', name: '', nameTouched: false, volNames: null, mode: 'new', target: '', ro: false, error: '', saving: false, picker: null, help: {} };
    document.getElementById('modal').hidden = false;
    renderDialog();
  }

  function closeDialog() {
    dlg = null;
    var root = document.getElementById('modal');
    root.hidden = true;
    clear(root);
  }

  function volOf(path) {
    var m = /^\/volume[A-Za-z0-9]+/.exec(path || '');
    return m ? m[0] : '';
  }

  // After the source is picked: suggest its last folder name for the share and
  // read the volume's top-level names so a clash is reported straight away.
  function sourceChosen() {
    var vol = volOf(dlg.source);
    var last = (dlg.source || '').split('/').filter(Boolean).pop() || '';
    if (!dlg.nameTouched) dlg.name = last;
    dlg.volNames = null;
    dlg.target = '';
    if (!vol) return;
    api('browse', { path: vol }).then(function (j) {
      if (!dlg || volOf(dlg.source) !== vol) return;
      dlg.volNames = (j.entries || []).map(function (e) { return String(e.name).toLowerCase(); });
      renderDialog();
    }).catch(function () { /* the helper checks again when the mount is saved */ });
  }

  function nameProblem(raw) {
    var n = (raw || '').trim();
    if (!n) return '';
    if (n.length > 64) return 'The name is too long (64 characters at most).';
    if (/[\\\/:*?"<>|%$@#]/.test(n) || /^[ .]|[ .]$/.test(n)) {
      return 'The name cannot contain \\ / : * ? " < > | % $ @ # or start or end with a space or full stop.';
    }
    if (dlg.volNames && dlg.volNames.indexOf(n.toLowerCase()) !== -1) {
      return 'A folder called "' + n + '" already exists on ' + volOf(dlg.source).replace('/', '') + '. The share needs a new, unique name.';
    }
    return '';
  }

  function finalTarget() {
    if (dlg.mode === 'existing') return dlg.target;
    var n = (dlg.name || '').trim();
    return n && volOf(dlg.source) ? volOf(dlg.source) + '/' + n : '';
  }

  function problemWithChoice() {
    if (dlg.mode === 'new') return nameProblem(dlg.name);
    var tgt = dlg.target;
    if (!dlg.source || !tgt) return '';
    if (volOf(dlg.source) !== volOf(tgt)) return 'The share has to be on the same volume as the source folder.';
    if (dlg.source === tgt) return 'The two folders must be different.';
    if ((tgt + '/').indexOf(dlg.source + '/') === 0) return 'The target cannot be inside the source folder.';
    if ((dlg.source + '/').indexOf(tgt + '/') === 0) return 'The source cannot be inside the target folder.';
    return '';
  }

  function chooseRow(which, label, hint, value) {
    return h('div', { class: 'field' },
      h('label', { class: 'lbl', text: label }),
      h('div', { class: 'hint', text: hint }),
      h('div', { class: 'choose' },
        h('div', { class: 'value' + (value ? '' : ' placeholder'), text: value || 'Nothing chosen yet' }),
        h('button', { text: value ? 'Change' : 'Choose folder', onclick: function () { openPicker(which); } })));
  }

  function renderDialog() {
    if (!dlg) return;
    var root = document.getElementById('modal');
    clear(root);
    root.appendChild(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, dlg.picker ? pickerView() : addView()));
  }

  // A "?" button that opens a block of help text under it
  function helpTip(key, label, lines, action) {
    var open = !!dlg.help[key];
    var btn = h('button', {
      class: 'qmark', type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-label': label, title: label, text: '?',
      onclick: function () { dlg.help[key] = !dlg.help[key]; renderDialog(); }
    });
    var head = h('div', { class: 'helphead' }, btn, h('span', { class: 'helplbl', text: label }));
    if (!open) return h('div', { class: 'helprow' }, head);
    return h('div', { class: 'helprow' }, head,
      h('div', { class: 'helpbox' }, lines.map(function (l) { return h('p', { text: l }); }), action || null));
  }

  function newShareBlock(host) {
    var vol = volOf(dlg.source);
    var nameIn = h('input', { type: 'text', class: 'nameinput', maxlength: '64', placeholder: 'tv', value: dlg.name, disabled: !dlg.source });
    nameIn.addEventListener('input', function () {
      var pos = nameIn.selectionStart;
      dlg.name = nameIn.value;
      dlg.nameTouched = true;
      renderDialog();
      var again = document.querySelector('.nameinput');
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* not supported */ } }
    });
    return h('div', { class: 'field' },
      h('label', { class: 'lbl', text: '2. Name of the new share' }),
      h('div', { class: 'hint', text: 'A new shared folder is created for you on the same volume. This is the name people will see.' }),
      h('div', { class: 'nameline' }, h('span', { class: 'unc', text: '\\\\' + host + '\\' }), nameIn),
      vol ? h('div', { class: 'hint', text: 'Created on ' + vol.replace('/', '') + ', the same volume as the source.' }) : null,
      h('button', {
        class: 'textlink', type: 'button', text: 'Use an existing empty folder instead',
        onclick: function () { dlg.mode = 'existing'; dlg.error = ''; renderDialog(); }
      }));
  }

  function existingShareBlock() {
    return [
      chooseRow('target', '2. Existing empty folder',
        'Pick a shared folder you already made. It has to be empty and on the same volume as the source.', dlg.target),
      h('button', {
        class: 'textlink', type: 'button', text: 'Create a new share instead',
        onclick: function () { dlg.mode = 'new'; dlg.error = ''; renderDialog(); }
      })
    ];
  }

  function addView() {
    var problem = problemWithChoice();
    var tgt = finalTarget();
    var ready = dlg.source && tgt && !problem && !dlg.saving;
    var host = (status && status.host) || 'NAS';
    var shareName = (dlg.name || '').trim() || 'tv';
    var roBox = h('input', { type: 'checkbox', checked: dlg.ro });
    roBox.addEventListener('change', function () { dlg.ro = roBox.checked; });

    var summary = null;
    if (dlg.source && tgt && !problem) {
      summary = dlg.mode === 'new'
        ? 'A new share \\\\' + host + '\\' + shareName + ' will be created and show everything in ' + dlg.source + '.'
        : 'Everything in ' + dlg.source + ' will also show up in ' + tgt + '.';
    }

    return h('div', null,
      h('h2', { text: 'Add a bind mount' }),
      h('p', { class: 'sub', text: 'Make a folder that already has files show up as its own share, without moving or copying anything.' }),
      chooseRow('source', '1. Folder with your files (source)',
        'The folder that already holds the files, for example /volume2/data/media/tv. It stays exactly where it is.', dlg.source),
      helpTip('src', 'What goes here?', [
        'This is the existing folder you want to reach from somewhere else.',
        'Nothing in it is moved, copied or changed. Its current permissions keep applying.'
      ]),
      dlg.mode === 'new' ? newShareBlock(host) : existingShareBlock(),
      helpTip('tgt', 'How does the new share work?', [
        'The app creates a new, empty shared folder with that name. Once the mount is on, it shows the files from the source folder, so \\\\' + host + '\\' + shareName + ' opens the same files as the source.',
        'It is limited to the same volume as the source on purpose. That keeps the new share next to your files and nothing is ever mounted across volumes.',
        'The name has to be new. If a folder with that name already exists on the volume you get an error, and nothing is touched.',
        'If DSM refuses to create the share from here, use "Use an existing empty folder instead" and create the share in Shared Folder first.'
      ], shareBtn()),
      helpTip('perm', 'Who gets access?', [
        'The files keep the permissions they already have, because they are the same files. You do not need new per-folder permissions.',
        'DSM also checks the share itself. A new share starts with administrators only. In Shared Folder, select the new share, click Edit, open the Permissions tab and give Read/Write to the users or group who should get in (for example the "users" group).',
        'After that, whatever the original folder allows or blocks for a person is what they get on the new share too.'
      ], shareBtn()),
      h('label', { class: 'check' }, roBox,
        h('span', null, h('strong', { text: 'Read only. ' }), 'People using the new share can look but not change files.')),
      summary ? h('div', { class: 'summary', text: summary }) : null,
      problem ? h('div', { class: 'errbox', text: problem }) : null,
      dlg.error ? h('div', { class: 'errbox', text: dlg.error }) : null,
      h('div', { class: 'actions' },
        h('button', { text: 'Cancel', onclick: closeDialog }),
        h('button', {
          class: 'primary', text: dlg.saving ? 'Adding...' : (dlg.mode === 'new' ? 'Create share and mount' : 'Add mount'),
          disabled: !ready, onclick: saveMount
        })));
  }

  // Polls the volume until a folder with this name shows up
  function waitForFolder(vol, name, tries) {
    return new Promise(function (resolve) {
      var i = 0;
      (function tick() {
        api('browse', { path: vol }).then(function (j) {
          var found = (j.entries || []).some(function (e) { return String(e.name).toLowerCase() === name.toLowerCase(); });
          if (found) { resolve(true); return; }
          i += 1;
          if (i >= tries) { resolve(false); return; }
          setTimeout(tick, 1000);
        }).catch(function () { resolve(false); });
      })();
    });
  }

  function createShareAndWait() {
    var name = dlg.name.trim();
    var vol = volOf(dlg.source);
    return createShare(name, vol).then(function () {
      return waitForFolder(vol, name, 8);
    }).then(function (found) {
      if (!found) throw new Error('DSM said the share was created but it is not showing up yet. Click the button again in a few seconds.');
    }).catch(function (e) {
      throw new Error('Could not create the share. ' + e.message + ' You can create it by hand in Shared Folder and use "Use an existing empty folder instead".');
    });
  }

  function saveMount() {
    var tgt = finalTarget();
    dlg.saving = true;
    dlg.error = '';
    renderDialog();
    (dlg.mode === 'new' ? createShareAndWait() : Promise.resolve()).then(function () {
      return api('add', { source: dlg.source, target: tgt, ro: dlg.ro ? '1' : '0' }, 'POST');
    }).then(function () {
      closeDialog();
      refresh();
      setTimeout(refresh, 2500);
    }).catch(function (e) {
      dlg.saving = false;
      dlg.error = e.message;
      renderDialog();
    });
  }

  // ---------- folder picker ----------
  function openPicker(which) {
    var start = which === 'source' ? dlg.source : dlg.target;
    dlg.picker = { which: which, path: '', parent: null, depth: 0, entries: [], loading: true, error: '' };
    renderDialog();
    browse(start ? start.replace(/\/[^\/]*$/, '') : '', true);
  }

  function browse(path, fallbackToRoot) {
    var p = dlg.picker;
    p.loading = true;
    p.error = '';
    renderDialog();
    api('browse', { path: path }).then(function (j) {
      if (!dlg || !dlg.picker) return;
      p.path = j.path;
      p.parent = j.parent;
      p.depth = j.depth;
      p.entries = j.entries || [];
      p.loading = false;
      renderDialog();
    }).catch(function (e) {
      if (!dlg || !dlg.picker) return;
      if (fallbackToRoot && path) { browse('', false); return; }
      p.loading = false;
      p.error = e.message;
      renderDialog();
    });
  }

  function crumbs(p) {
    var parts = p.path ? p.path.split('/').filter(Boolean) : [];
    var out = [h('button', { text: 'Volumes', onclick: function () { browse('', false); } })];
    var acc = '';
    parts.forEach(function (part) {
      acc += '/' + part;
      var target = acc;
      out.push(h('span', { class: 'sep', text: '/' }));
      out.push(h('button', { text: part, onclick: function () { browse(target, false); } }));
    });
    return h('div', { class: 'crumbs' }, out);
  }

  function pickerView() {
    var p = dlg.picker;
    var isSource = p.which === 'source';
    var rows;
    if (p.loading) {
      rows = h('div', { class: 'nofolders', text: 'Loading...' });
    } else if (!p.entries.length) {
      rows = h('div', { class: 'nofolders', text: p.depth === 0 ? 'No volumes found' : 'No folders in here' });
    } else {
      rows = p.entries.map(function (e) {
        var full = (p.path || '') + '/' + e.name;
        var tag = null;
        if (e.mounted) tag = h('span', { class: 'tag', text: 'already a mount' });
        else if (e.empty === true) tag = h('span', { class: 'tag', text: 'empty' });
        return h('button', { class: 'folder', onclick: function () { browse(full, false); } },
          h('span', { class: 'ic' }), h('span', { class: 'name', text: e.name }), tag);
      });
    }

    var hint = isSource
      ? 'Open the folder you want to share and press "Use this folder".'
      : 'Open the empty shared folder you made and press "Use this folder". It has to be on the same volume as the source.';

    return h('div', null,
      h('h2', { text: isSource ? 'Choose the folder to share' : 'Choose the empty folder' }),
      h('p', { class: 'sub', text: hint }),
      crumbs(p),
      p.error ? h('div', { class: 'errbox', text: p.error }) : null,
      h('div', { class: 'folders' }, rows),
      p.path ? h('div', { class: 'picked', text: 'Current folder: ' + p.path }) : null,
      h('div', { class: 'actions' },
        h('button', { text: 'Back', onclick: function () { dlg.picker = null; renderDialog(); } }),
        h('button', {
          class: 'primary', text: 'Use this folder', disabled: !(p.path && p.depth >= 1),
          onclick: function () {
            dlg[p.which] = p.path;
            dlg.picker = null;
            dlg.error = '';
            if (p.which === 'source') sourceChosen();
            renderDialog();
          }
        })));
  }

  // ---------- start ----------
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && dlg) closeDialog();
  });

  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      if (document.hidden || dlg) { schedule(); return; }
      refresh().then(schedule);
    }, helperAlive() ? POLL_MS : POLL_MS_NO_HELPER);
  }

  initToken().then(refresh).then(schedule);
})();
