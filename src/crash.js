/**
 * Журнал ошибок и окно со стектрейсом.
 * Ловит исключения игрового цикла, window.onerror, необработанные промисы,
 * ошибки шейдеров (console.error от three.js) и потерю WebGL-контекста.
 * Последние записи сохраняются в localStorage — их видно и после перезагрузки страницы.
 */
const STORE_KEY = 'cars-and-guts:crash-log';
const MAX_ENTRIES = 12;

function safeJSON(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch (e) {
    return `(не удалось сериализовать: ${e.message})`;
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export class CrashReporter {
  constructor(version) {
    this.version = version;
    this.entries = [];
    this.previous = this._load();
    this.getContext = null; // () => объект с состоянием игры
    this.onContinue = null;
    this.onRestart = null;
    this.onOpenChange = null;
    this._build();

    window.addEventListener('error', (e) => {
      // ошибки загрузки ресурсов (картинки, шрифты) не интересны
      if (!e.error && !e.message) return;
      this.report(e.error || { message: e.message, stack: `${e.filename || '?'}:${e.lineno || 0}:${e.colno || 0}` }, 'window.onerror');
    });
    window.addEventListener('unhandledrejection', (e) => this.report(e.reason, 'promise'));

    const origError = console.error.bind(console);
    console.error = (...args) => {
      origError(...args);
      try {
        const text = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' ');
        const serious = /shader|webgl|program|context/i.test(text);
        this._add({ kind: 'console.error', message: text.slice(0, 600), stack: '' }, serious);
      } catch {
        // журнал не должен ронять игру
      }
    };
  }

  /** Исключение: пишем в журнал и показываем окно. */
  report(err, source = 'game loop') {
    const message = (err && (err.message || err.reason)) || String(err);
    const stack = (err && err.stack) || '';
    this._add({ kind: source, message: String(message), stack: String(stack) }, true);
  }

  /** Заметка без исключения (зависание кадра, восстановление контекста). */
  note(message, open = false) {
    this._add({ kind: 'note', message, stack: '' }, open);
  }

  _add(entry, open) {
    const key = `${entry.kind}|${entry.message}|${entry.stack.slice(0, 300)}`;
    const now = Date.now();
    let e = this.entries.find((x) => x.key === key);
    if (e) {
      e.count++;
      e.last = now;
    } else {
      let ctx = null;
      try {
        ctx = this.getContext ? this.getContext() : null;
      } catch (ce) {
        ctx = { contextError: ce.message };
      }
      e = { ...entry, key, count: 1, first: now, last: now, context: ctx };
      this.entries.push(e);
      if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    }
    this._save();
    if (open) this.open();
    else if (this.isOpen) this._render();
  }

  get hasErrors() {
    return this.entries.some((e) => e.kind !== 'note' && e.kind !== 'console.error');
  }

  // ------------------------------------------------------------ хранение
  _load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  _save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ when: Date.now(), version: this.version, entries: this.entries.map(({ key, ...rest }) => rest) }));
    } catch {
      // приватный режим или запрет хранилища — не страшно
    }
  }

  clearStored() {
    this.previous = null;
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      // ignore
    }
  }

  // ------------------------------------------------------------ окно
  _build() {
    const root = document.createElement('div');
    root.id = 'crash';
    root.className = 'crash hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.innerHTML = `
      <div class="crash-panel">
        <div class="crash-head">
          <b id="crash-title">Игра упала</b>
          <span id="crash-meta"></span>
        </div>
        <p class="crash-hint">Скопируй текст ниже и пришли его — по нему видно, где и в каком состоянии всё сломалось.</p>
        <pre id="crash-text" class="crash-text" tabindex="0"></pre>
        <div class="crash-btns">
          <button type="button" data-act="copy">Скопировать</button>
          <button type="button" data-act="continue">Продолжить</button>
          <button type="button" data-act="restart">Начать заново</button>
          <button type="button" data-act="close">Закрыть</button>
        </div>
        <p id="crash-copied" class="crash-copied" aria-live="polite"></p>
      </div>`;
    document.body.appendChild(root);
    this.el = root;
    this.textEl = root.querySelector('#crash-text');
    this.titleEl = root.querySelector('#crash-title');
    this.metaEl = root.querySelector('#crash-meta');
    this.copiedEl = root.querySelector('#crash-copied');
    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      e.preventDefault();
      if (act === 'copy') this._copy();
      else if (act === 'continue') {
        this.close();
        if (this.onContinue) this.onContinue();
      } else if (act === 'restart') {
        this.close();
        if (this.onRestart) this.onRestart();
      } else if (act === 'close') this.close();
    });
    // клавиши игры не должны срабатывать, пока окно открыто
    root.addEventListener('keydown', (e) => e.stopPropagation());
  }

  get isOpen() {
    return !this.el.classList.contains('hidden');
  }

  /** Открыть журнал. showPrevious — показать ошибки прошлой сессии. */
  open(showPrevious = false) {
    this._showPrevious = showPrevious;
    this._render();
    const wasOpen = this.isOpen;
    this.el.classList.remove('hidden');
    if (!wasOpen && this.onOpenChange) this.onOpenChange(true);
  }

  close() {
    if (!this.isOpen) return;
    this.el.classList.add('hidden');
    if (this.onOpenChange) this.onOpenChange(false);
  }

  _render() {
    const prev = this._showPrevious && this.previous;
    const list = prev ? this.previous.entries || [] : this.entries;
    const errors = list.filter((e) => e.kind !== 'note' && e.kind !== 'console.error');
    if (prev) this.titleEl.textContent = 'Ошибки прошлой сессии';
    else this.titleEl.textContent = errors.length ? 'Игра упала' : list.length ? 'Журнал' : 'Ошибок пока не было';
    this.metaEl.textContent = list.length ? `${list.length} запис.` : '';
    this.textEl.textContent = list.length ? this.text(list, prev ? this.previous.version : this.version) : 'Журнал пуст. Если что-то сломается, подробности появятся здесь.';
    this.copiedEl.textContent = '';
  }

  text(list = this.entries, version = this.version) {
    const head = [
      `Cars & Guts ${version}`,
      `Время: ${new Date().toISOString()}`,
      `Браузер: ${navigator.userAgent}`,
      `Экран: ${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio || 1}`,
    ].join('\n');
    const body = list
      .slice()
      .reverse()
      .map((e, i) => {
        const rep = e.count > 1 ? ` (×${e.count}, последний раз ${fmtTime(e.last)})` : '';
        const parts = [`#${i + 1} [${e.kind}] ${fmtTime(e.first)}${rep}`, e.message];
        if (e.stack) parts.push(e.stack);
        if (e.context) parts.push(`Состояние: ${safeJSON(e.context)}`);
        return parts.join('\n');
      })
      .join('\n\n────────\n\n');
    return `${head}\n\n${body}`;
  }

  _copy() {
    const text = this.textEl.textContent;
    const select = () => {
      const r = document.createRange();
      r.selectNodeContents(this.textEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    };
    try {
      navigator.clipboard
        .writeText(text)
        .then(() => (this.copiedEl.textContent = 'Скопировано.'))
        .catch(() => {
          select();
          this.copiedEl.textContent = 'Не получилось скопировать автоматически — текст выделен, скопируй вручную.';
        });
    } catch {
      select();
      this.copiedEl.textContent = 'Текст выделен — скопируй вручную.';
    }
  }
}
