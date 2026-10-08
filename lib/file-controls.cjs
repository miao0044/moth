'use strict';

// Keep these small outline icons consistent with the existing sidebar controls.
const ICONS = {
  new: '<path d="M8 2v12M2 8h12"/>',
  open: '<path d="M4.5 2h5L13 5.5V14H4.5V2z"/><path d="M9.5 2v4H13"/>',
  folder: '<path d="M2 4.5h4l1.5 1.5H14v7H2V4.5z"/>',
  save: '<path d="M2.5 2h9l2 2V14h-11V2z"/><path d="M5 2v4h6V2M5 14V9h6v5"/>',
  'save-as': '<path d="M8 2H2.5v12h11V8M5 14V9h4"/><path d="m8 6 4-4 2 2-4 4H8V6z"/>',
  'save-all': '<path d="M4.5 2h7l2 2v7h-9V2zM7 2v3h4V2M7 11V8h4v3M2 5v9h9"/>',
  reload: '<path d="M13 6a5 5 0 1 0 .2 3M13 2v4H9"/>',
  reopen: '<path d="M3 6a5 5 0 1 1-.2 3M3 2v4h4"/>',
  recent: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.5V8l2.5 1.5"/>',
  clear: '<path d="M3 4h10M6 4V2h4v2M4.5 4l.5 10h6l.5-10M7 6v5M9 6v5"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  check: '<path d="m3 8 3.5 3.5L13 5"/>',
  error: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.5v4M8 10.5v1"/>',
  external: '<path d="M6 3H2.5v11h11v-3M9 2h5v5M14 2 7 9"/>',
  recovery: '<path d="M3 6a5 5 0 1 1-.2 3M3 2v4h4M8 5v3l2 1"/>',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('aria-hidden', 'true');
  // Only locally defined SVG paths are inserted; file paths and labels use textContent.
  svg.innerHTML = ICONS[name] || ICONS.open;
  return svg;
}

function parentLabel(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const parent = normalized.slice(0, normalized.lastIndexOf('/')) || '/';
  const parts = parent.split('/').filter(Boolean);
  return parent.length > 36 && parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parent;
}

function createFileControls({ onCommand }) {
  const saveButton = document.getElementById('btn-save');
  const menuButton = document.getElementById('btn-file-menu');
  const sidebarHeader = document.getElementById('sidebar-header');
  const tabBar = document.getElementById('tab-bar');
  const menu = document.getElementById('file-menu');
  const notice = document.getElementById('document-notice');
  const confirmDialog = document.getElementById('file-confirm');
  const confirmTitle = document.getElementById('file-confirm-title');
  const confirmMessage = document.getElementById('file-confirm-message');
  const confirmDetail = document.getElementById('file-confirm-detail');
  const confirmActions = document.getElementById('file-confirm-actions');
  let model = { canSave: false, canSaveAll: false, canReload: false, canReopen: false, recentFiles: [] };
  let signature = '';
  let destroyed = false;
  let activeConfirmation = null;
  const listeners = [];

  function listen(element, event, handler) {
    element.addEventListener(event, handler);
    listeners.push(() => element.removeEventListener(event, handler));
  }

  function items() {
    return [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  }

  function closeMenu(restoreFocus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    menuButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus && menuButton.isConnected) menuButton.focus({ preventScroll: true });
  }

  function positionMenu() {
    if (menu.hidden) return;
    const bounds = menuButton.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${bounds.bottom + 4}px`;
    menu.style.maxHeight = `${Math.max(64, window.innerHeight - bounds.bottom - 12)}px`;
  }

  function setSidebarVisible(visible) {
    if (destroyed) return;
    const parent = visible ? sidebarHeader : tabBar;
    if (menuButton.parentElement !== parent) {
      const wasFocused = document.activeElement === menuButton;
      parent.prepend(menuButton);
      if (wasFocused) menuButton.focus({ preventScroll: true });
    }
    positionMenu();
  }

  function openMenu(last = false) {
    if (destroyed) return;
    document.getElementById('settings-panel')?.classList.remove('open');
    menu.hidden = false;
    menuButton.setAttribute('aria-expanded', 'true');
    positionMenu();
    const enabled = items();
    (last ? enabled.at(-1) : enabled[0])?.focus({ preventScroll: true });
  }

  function invoke(name, payload) {
    closeMenu(true);
    return onCommand(name, payload);
  }

  function addItem(name, label, shortcut, enabled = true, payload, iconName = name) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'file-menu-item';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    button.disabled = !enabled;
    button.dataset.command = name;
    if (payload !== undefined) button.dataset.path = payload;
    button.append(icon(iconName));
    const text = document.createElement('span');
    text.className = 'file-menu-label';
    text.textContent = label;
    button.append(text);
    if (shortcut) {
      const keys = document.createElement('span');
      keys.className = 'file-menu-shortcut';
      keys.setAttribute('aria-hidden', 'true');
      keys.textContent = shortcut;
      button.append(keys);
    }
    button.addEventListener('click', () => invoke(name, payload));
    menu.append(button);
    return button;
  }

  function separator() {
    const line = document.createElement('div');
    line.className = 'file-menu-separator';
    line.setAttribute('role', 'separator');
    menu.append(line);
  }

  function rebuildMenu() {
    const focused = menu.contains(document.activeElement) ? document.activeElement : null;
    const focusedCommand = focused?.dataset.command;
    const focusedPath = focused?.dataset.path;
    menu.replaceChildren();
    addItem('new', 'New File', 'Ctrl+N');
    addItem('open', 'Open File…', 'Ctrl+O');
    addItem('open-folder', 'Open Folder…', '', true, undefined, 'folder');
    separator();
    addItem('save', 'Save', 'Ctrl+S', model.canSave);
    addItem('save-as', 'Save As…', 'Ctrl+Shift+S', model.canSave, undefined, 'save-as');
    addItem('save-all', 'Save All', 'Ctrl+Alt+S', model.canSaveAll);
    addItem('reload', 'Reload from Disk', '', model.canReload);
    separator();
    addItem('reopen', 'Reopen Closed Tab', 'Ctrl+Shift+T', model.canReopen);
    separator();
    const heading = document.createElement('div');
    heading.className = 'file-menu-heading';
    heading.setAttribute('role', 'presentation');
    heading.textContent = 'Recent Files';
    menu.append(heading);
    for (const file of model.recentFiles) {
      const button = addItem('open-recent', file.name, '', true, file.path, 'recent');
      button.title = file.path;
      button.setAttribute('aria-label', `${file.name}, ${file.path}`);
      const label = button.querySelector('.file-menu-label');
      label.classList.add('file-menu-recent-label');
      label.replaceChildren();
      const name = document.createElement('span');
      name.className = 'file-menu-recent-name';
      name.textContent = file.name;
      const parent = document.createElement('span');
      parent.className = 'file-menu-recent-parent';
      parent.textContent = parentLabel(file.path);
      label.append(name, parent);
    }
    if (!model.recentFiles.length) {
      const empty = document.createElement('div');
      empty.className = 'file-menu-empty';
      empty.setAttribute('role', 'presentation');
      empty.textContent = 'No recent files';
      menu.append(empty);
    } else {
      addItem('clear-recent', 'Clear Recent Files', '', true, undefined, 'clear');
    }
    if (focused) {
      const target = items().find(item => item.dataset.command === focusedCommand && item.dataset.path === focusedPath);
      (target || items()[0])?.focus({ preventScroll: true });
    }
    positionMenu();
  }

  function update(nextModel) {
    if (destroyed) return;
    model = {
      canSave: Boolean(nextModel.canSave),
      canSaveAll: Boolean(nextModel.canSaveAll),
      canReload: Boolean(nextModel.canReload),
      canReopen: Boolean(nextModel.canReopen),
      recentFiles: (nextModel.recentFiles || []).filter(file => file && typeof file.path === 'string').slice(0, 10).map(file => ({
        path: file.path,
        name: file.name || file.path.split(/[\\/]/).at(-1) || file.path,
      })),
    };
    saveButton.disabled = !model.canSave;
    const nextSignature = JSON.stringify(model);
    if (nextSignature !== signature) {
      signature = nextSignature;
      rebuildMenu();
    }
  }

  function showNotice({ message, kind = 'error', actions = [] }) {
    if (destroyed) return;
    notice.replaceChildren();
    notice.dataset.kind = kind;
    const indicator = document.createElement('span');
    indicator.className = 'document-notice-icon';
    indicator.append(icon(kind));
    const text = document.createElement('span');
    text.className = 'document-notice-message';
    text.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    text.setAttribute('aria-atomic', 'true');
    text.textContent = message;
    text.title = message;
    notice.append(indicator, text);
    if (actions.length) {
      const controls = document.createElement('div');
      controls.className = 'document-notice-actions';
      for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'document-notice-action';
        button.title = action.label;
        button.setAttribute('aria-label', action.label);
        const label = action.label.toLowerCase();
        const inferredIcon = /dismiss|close|cancel/.test(label) ? 'close'
          : /discard|delete/.test(label) ? 'clear'
          : /reload/.test(label) ? 'reload'
          : /save as/.test(label) ? 'save-as'
          : /save|overwrite|replace/.test(label) ? 'save'
          : /restore|recover/.test(label) ? 'recovery'
          : /keep|continue/.test(label) ? 'check' : 'open';
        button.append(icon(action.icon || inferredIcon));
        // Consequential choices need a visible word as well as a tooltip.
        if (/discard|overwrite|replace/.test(label)) {
          const caption = document.createElement('span');
          caption.textContent = action.label;
          button.append(caption);
        }
        button.addEventListener('click', action.onClick);
        controls.append(button);
      }
      notice.append(controls);
    }
    notice.hidden = false;
  }

  function clearNotice() {
    notice.hidden = true;
    notice.replaceChildren();
    delete notice.dataset.kind;
  }

  function finishConfirmation(value) {
    const pending = activeConfirmation;
    if (!pending) return;
    activeConfirmation = null;
    if (confirmDialog.open) confirmDialog.close();
    if (pending.previousFocus?.isConnected) pending.previousFocus.focus({ preventScroll: true });
    pending.resolve(value);
  }

  function confirm({ title, message, detail, choices = [], cancelValue, defaultValue }) {
    // A second action must never replace an unanswered decision about a file.
    if (destroyed || activeConfirmation) return Promise.resolve(cancelValue);
    closeMenu(true);
    const previousFocus = document.activeElement;
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmDetail.textContent = detail || '';
    confirmDetail.hidden = !detail;
    confirmDialog.setAttribute('aria-describedby', detail
      ? 'file-confirm-message file-confirm-detail' : 'file-confirm-message');
    confirmActions.replaceChildren();
    const options = choices.length ? choices : [{ value: cancelValue, label: 'Cancel', icon: 'close' }];
    const defaultChoice = options.find(choice => Object.is(choice.value, defaultValue))
      || options.find(choice => Object.is(choice.value, cancelValue)) || options[0];
    let defaultButton;
    for (const choice of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'file-confirm-action';
      button.setAttribute('aria-label', choice.label);
      if (choice.icon) button.append(icon(choice.icon));
      const label = document.createElement('span');
      label.textContent = choice.label;
      button.append(label);
      if (choice === defaultChoice) {
        button.autofocus = true;
        defaultButton = button;
      }
      button.addEventListener('click', () => finishConfirmation(choice.value));
      confirmActions.append(button);
    }
    return new Promise(resolve => {
      activeConfirmation = { resolve, cancelValue, previousFocus };
      try {
        confirmDialog.showModal();
        defaultButton.focus({ preventScroll: true });
      } catch {
        finishConfirmation(cancelValue);
      }
    });
  }

  listen(confirmDialog, 'cancel', event => {
    event.preventDefault();
    finishConfirmation(activeConfirmation?.cancelValue);
  });
  listen(confirmDialog, 'close', () => {
    if (!confirmDialog.open) finishConfirmation(activeConfirmation?.cancelValue);
  });
  // Keep editor shortcuts and Chromium's window-level Tab target out of a decision.
  listen(confirmDialog, 'keydown', event => {
    event.stopPropagation();
    if (event.key !== 'Tab') return;
    const buttons = [...confirmActions.querySelectorAll('button:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement);
    const next = current < 0 ? 0 : (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true });
  });
  listen(saveButton, 'click', () => onCommand('save'));
  listen(menuButton, 'click', () => menu.hidden ? openMenu() : closeMenu(true));
  listen(menuButton, 'keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      openMenu(event.key === 'ArrowUp');
    }
  });
  listen(menu, 'keydown', event => {
    const enabled = items();
    const index = enabled.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = enabled[(index + 1) % enabled.length];
    else if (event.key === 'ArrowUp') next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (event.key === 'Home') next = enabled[0];
    else if (event.key === 'End') next = enabled.at(-1);
    else if (event.key === 'Escape') closeMenu(true);
    else if (event.key === 'Tab') {
      // Return to the trigger before normal Tab navigation leaves the menu.
      closeMenu(true);
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: 'nearest' });
  });
  listen(document, 'pointerdown', event => {
    if (!menu.contains(event.target) && !menuButton.contains(event.target)) closeMenu();
  });
  listen(document, 'focusin', event => {
    if (!menu.contains(event.target) && !menuButton.contains(event.target)) closeMenu();
  });
  listen(window, 'resize', positionMenu);
  listen(document.getElementById('sidebar'), 'transitionend', event => {
    if (event.target === event.currentTarget && (event.propertyName === 'width' || event.propertyName === 'min-width')) positionMenu();
  });
  listen(window, 'blur', () => closeMenu());
  setSidebarVisible(false);
  update(model);

  return {
    update,
    setSidebarVisible,
    showNotice,
    clearNotice,
    confirm,
    destroy() {
      if (destroyed) return;
      finishConfirmation(activeConfirmation?.cancelValue);
      closeMenu();
      clearNotice();
      listeners.splice(0).forEach(remove => remove());
      menu.replaceChildren();
      destroyed = true;
    },
  };
}

module.exports = { createFileControls };
