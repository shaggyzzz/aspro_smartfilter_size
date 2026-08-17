/**
 * SizeFilter — надстройка над умным фильтром Битрикс (шаблон Аспро Макс).
 *
 * Превращает список чекбоксов «ШxД» (80x190, 160x200, …) свойства «Размер»
 * в поле «Выберите размер», открывающее попап с двумя колонками
 * «Ширина, см» / «Длина, см» — как на mnogosna.ru.
 * В попапе сверху — популярные размеры (160×200, …), одним кликом;
 * остальные выбираются в колонках «Ширина» / «Длина».
 *
 * Принцип работы: исходные чекбоксы остаются в DOM (скрываются стилями)
 * и служат источником данных. Клик по кнопке размера находит соответствующий
 * чекбокс и вызывает его нативный click() — срабатывает штатный
 * smartFilter.click(), ajax и перерисовка каталога. После перерисовки фильтра
 * скрипт автоматически инициализируется заново (MutationObserver), попап
 * при этом переоткрывается, выбранная ширина и прокрутка колонок сохраняются.
 *
 * Настройки — задать window.SizeFilterConfig ДО подключения этого файла.
 * Подробности — в README.md.
 */
(function () {
  'use strict';

  var DEFAULTS = {
    // data-prop_code блоков фильтра, которые нужно преобразовать
    propCodes: ['razmer'],
    popupTitle: 'Выберите размер (Ш × Д)',
    placeholder: 'Выберите размер',
    selectedText: 'Выбрано размеров',
    widthTitle: 'Ширина, см',
    lengthTitle: 'Длина, см',
    otherTitle: 'Другие размеры',
    hintText: 'Выберите ширину и длину',
    resetText: 'Сбросить размеры',
    doneText: 'Готово',
    // показывать количество товаров рядом с длиной (для выбранной ширины)
    showCounts: true,
    // переносить чекбокс в видимый элемент пикера перед click(), чтобы
    // BX.pos() в smartFilter возвращал осмысленные координаты
    moveInputs: true,
    // ширина попапа на десктопе
    popupWidth: 344,
    mobileMedia: '(max-width: 767px)',
    // популярные размеры вверху попапа — клик сразу включает пару Ш×Д.
    // Пустой массив — блок не показывается. Нет в текущем фильтре — пункт
    // пропускается.
    quickTitle: 'Популярные размеры',
    quickSizes: ['160x200', '140x200', '180x200', '90x200'],
    quickSizeCount: 4
  };

  // 80x190, 80х190 (рус.), 80×190, 80*190, допускаются дробные: 82,5x190
  var SIZE_RE = /^(\d+(?:[.,]\d+)?)\s*[xх×*]\s*(\d+(?:[.,]\d+)?)$/i;

  // состояние по property_id — переживает ajax-перерисовку фильтра:
  // выбранная ширина/длина, открыт ли попап, прокрутка колонок
  var stateStore = {};

  // если пересобрать пикер не удалось (блок пропал из ответа, ошибка,
  // значений меньше двух), а попап перед перерисовкой был открыт —
  // снять блокировку прокрутки и погасить флаг, иначе страница останется
  // с overflow:hidden без видимого попапа
  function releaseOpenState(propId) {
    var mem = stateStore[propId];
    if (mem && mem.open) {
      mem.open = false;
      document.documentElement.classList.remove('sf-lock');
    }
  }

  var mqMobile = null;

  function config() {
    var user = window.SizeFilterConfig || {};
    var out = {}, k;
    for (k in DEFAULTS) {
      out[k] = Object.prototype.hasOwnProperty.call(user, k) ? user[k] : DEFAULTS[k];
    }
    return out;
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      if (t) clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  function h(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function stripCount(s) {
    // "80x190 (394)" -> "80x190"
    return String(s || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  }

  function parseSize(raw) {
    var m = SIZE_RE.exec(stripCount(raw));
    if (!m) return null;
    var w = parseFloat(m[1].replace(',', '.'));
    var l = parseFloat(m[2].replace(',', '.'));
    if (!isFinite(w) || !isFinite(l)) return null;
    return { w: w, l: l };
  }

  function numAsc(a, b) { return a - b; }

  // дробные — с запятой, как в исходных данных: 82.5 -> «82,5»
  function fmt(n) { return String(n).replace('.', ','); }

  function isMobile() { return !!(mqMobile && mqMobile.matches); }

  function sizeKey(sz) { return sz.w + '|' + sz.l; }

  // какие из configured quickSizes реально есть в текущем блоке фильтра
  function resolveQuickItems(sized, C) {
    var specs = C.quickSizes;
    if (!specs || !specs.length) return [];
    var limit = parseInt(C.quickSizeCount, 10);
    if (!(limit > 0)) limit = 4;
    var byKey = {};
    sized.forEach(function (it) {
      if (it.size) byKey[sizeKey(it.size)] = it;
    });
    var out = [];
    for (var i = 0; i < specs.length && out.length < limit; i++) {
      var sz = parseSize(specs[i]);
      if (!sz) continue;
      var it = byKey[sizeKey(sz)];
      if (it && out.indexOf(it) === -1) out.push(it);
    }
    return out;
  }

  /* ---------- чтение данных из исходного фильтра ---------- */

  function collectItems(box) {
    var items = [];
    var inputs = box.querySelectorAll('.bx_filter_parameters_box_container input[type="checkbox"]');
    Array.prototype.forEach.call(inputs, function (input) {
      if (!input.id) return;
      var label = box.querySelector('label[for="' + input.id + '"]');
      if (!label) return;
      var textEl = label.querySelector('.bx_filter_param_text');
      var raw = textEl
        ? (textEl.getAttribute('title') || textEl.textContent || '')
        : (label.textContent || '');
      items.push({
        input: input,
        label: label,
        countEl: label.querySelector('[data-role^="count_"]'),
        raw: stripCount(raw),
        size: parseSize(raw)
      });
    });
    return items;
  }

  function itemCount(it) {
    if (!it || !it.countEl) return NaN;
    return parseInt(it.countEl.textContent, 10);
  }

  function itemDisabled(it) {
    return it.input.disabled || it.label.classList.contains('disabled');
  }

  // доступен для клика: отмеченный — всегда (чтобы можно было снять),
  // иначе — не disabled и счётчик не равен нулю
  function itemAvailable(it) {
    if (!it) return false;
    if (it.input.checked) return true;
    if (itemDisabled(it)) return false;
    var c = itemCount(it);
    return isNaN(c) || c > 0;
  }

  /* ---------- построение пикера для одного блока фильтра ---------- */

  function enhance(box, C) {
    if (box.hasAttribute('data-sf-enhanced')) return;

    var propId = box.getAttribute('data-property_id') || box.getAttribute('data-prop_code') || '';

    var container = box.querySelector('.bx_filter_parameters_box_container');
    if (!container) return;
    var block = box.querySelector('.bx_filter_block') || container.parentNode;
    if (!block) return;

    var items = collectItems(box);
    var sized = items.filter(function (it) { return !!it.size; });
    if (sized.length < 2) {
      // преобразовывать нечего — оставляем штатный фильтр видимым
      box.setAttribute('data-sf-enhanced', 'N');
      box.classList.add('sf-native');
      releaseOpenState(propId);
      return;
    }
    var other = items.filter(function (it) { return !it.size; });

    // guard от повторного входа; класс sf-enhanced (скрывающий исходный
    // список) добавляется только в самом конце, когда пикер уже построен —
    // при любой ошибке фильтр остаётся штатным
    box.setAttribute('data-sf-enhanced', 'Y');

    try {
      var mem = stateStore[propId];
      // после ajax-перерисовки набор значений обычно тот же — тогда не
      // пересоздаём пикер, а переносим живые DOM-узлы старого в новый блок
      // и перепривязываем к новым чекбоксам: обновляются только данные
      // (счётчики, доступность, «Показать N товаров»), попап не мигает
      if (mem && mem.inst && mem.inst.rebind(box, block, container, sized, other)) {
        box.classList.remove('sf-native');
        box.classList.add('sf-enhanced');
        return;
      }
      buildPicker(box, block, container, sized, other, C, propId);
      box.classList.remove('sf-native');
      box.classList.add('sf-enhanced');
    } catch (e) {
      box.setAttribute('data-sf-enhanced', 'N');
      box.classList.add('sf-native');
      releaseOpenState(propId);
      if (stateStore[propId]) stateStore[propId].inst = null;
      Array.prototype.forEach.call(
        box.querySelectorAll('.sf-size-picker, .sf-popup, .sf-backdrop'),
        function (el) { if (el.parentNode) el.parentNode.removeChild(el); }
      );
      throw e;
    }
  }

  function buildPicker(box, block, container, sized, other, C, propId) {
    var mem = stateStore[propId] = stateStore[propId] || {
      selW: null, selL: null, open: false, scrollW: 0, scrollL: 0
    };

    var modefEl = box.querySelector('.bx_filter_container_modef');

    /* модель: комбинации, уникальные ширины и длины */
    var combos = {}, widths = [], lengths = [];
    sized.forEach(function (it) {
      combos[sizeKey(it.size)] = it;
      if (widths.indexOf(it.size.w) === -1) widths.push(it.size.w);
      if (lengths.indexOf(it.size.l) === -1) lengths.push(it.size.l);
    });
    widths.sort(numAsc);
    lengths.sort(numAsc);

    function comboAt(w, l) { return combos[sizeKey({ w: w, l: l })] || null; }
    function checkedItems() {
      var res = [];
      sized.forEach(function (it) { if (it.input.checked) res.push(it); });
      other.forEach(function (it) { if (it.input.checked) res.push(it); });
      return res;
    }

    /* состояние колонок:
       selW — активная ширина (контекст для колонки длин),
       selL — «ожидающая» длина, если её выбрали раньше ширины */
    var selW = null, selL = null;
    if (mem.selW !== null && widths.indexOf(mem.selW) !== -1) selW = mem.selW;
    if (mem.selL !== null && lengths.indexOf(mem.selL) !== -1 && selW === null) selL = mem.selL;
    if (selW === null && selL === null) {
      var firstChecked = checkedItems()[0];
      if (firstChecked && firstChecked.size) selW = firstChecked.size.w;
    }

    function remember() {
      mem.selW = selW;
      mem.selL = selL;
    }

    /* ---------- DOM: поле-триггер, чипсы, сброс ---------- */

    var root = h('div', 'sf-size-picker');

    // персистентные «якоря» для перенесённых чекбоксов (см. toggleItem):
    // все находятся внутри формы умного фильтра и не пересоздаются в renderAll
    var fieldWrap = h('div', 'sf-field-wrap sf-anchor-host');
    var field = h('button', 'sf-field');
    field.type = 'button';
    field.setAttribute('aria-haspopup', 'dialog');
    field.setAttribute('aria-expanded', 'false');
    var fieldText = h('span', 'sf-field-text');
    field.appendChild(fieldText);
    field.appendChild(h('span', 'sf-field-arrow'));
    fieldWrap.appendChild(field);
    root.appendChild(fieldWrap);

    var chipsRow = h('div', 'sf-chips-row sf-anchor-host');
    var chipsList = h('div', 'sf-chips');
    chipsRow.appendChild(chipsList);
    root.appendChild(chipsRow);

    var reset = h('div', 'sf-reset sf-anchor-host');
    var resetLink = h('span', 'sf-reset-link', C.resetText);
    reset.appendChild(resetLink);
    resetLink.addEventListener('click', resetAll);
    root.appendChild(reset);

    /* ---------- DOM: попап ---------- */

    // попап живёт в box (не в .bx_filter_block): его не задевает
    // сворачивание блока в Аспро и overflow скролл-плагина
    var popup = h('div', 'sf-popup');
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-modal', 'true');
    popup.setAttribute('aria-label', C.popupTitle);
    popup.tabIndex = -1;

    var inner = h('div', 'sf-popup-inner');
    popup.appendChild(inner);

    var head = h('div', 'sf-popup-head');
    head.appendChild(h('div', 'sf-popup-title', C.popupTitle));
    var closeBtn = h('button', 'sf-popup-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Закрыть');
    closeBtn.innerHTML = '&times;';
    head.appendChild(closeBtn);
    inner.appendChild(head);

    var quickHolders = [];
    var quickItems = resolveQuickItems(sized, C);
    if (quickItems.length) {
      var quickBlock = h('div', 'sf-quick-block');
      if (C.quickTitle) quickBlock.appendChild(h('div', 'sf-col-title', C.quickTitle));
      var quickRow = h('div', 'sf-quick');
      quickItems.forEach(function (it) {
        var btn = h('button', 'sf-btn sf-quick-btn');
        btn.type = 'button';
        btn.appendChild(h('span', 'sf-val', fmt(it.size.w) + '×' + fmt(it.size.l)));
        btn.setAttribute('aria-label', 'Размер ' + fmt(it.size.w) + '×' + fmt(it.size.l));
        var holder = { it: it, btn: btn };
        btn._sfHolder = holder;
        btn.addEventListener('click', function () {
          var cur = holder.it;
          if (!itemAvailable(cur)) return;
          // чекбокс в fieldWrap, не в попап — иначе перекрыл бы всплывашку
          selW = cur.size.w;
          selL = null;
          remember();
          toggleItem(cur);
        });
        quickRow.appendChild(btn);
        quickHolders.push(holder);
      });
      quickBlock.appendChild(quickRow);
      inner.appendChild(quickBlock);
    }

    var hint = h('div', 'sf-hint', C.hintText);
    inner.appendChild(hint);

    var cols = h('div', 'sf-cols');
    inner.appendChild(cols);

    function makeCol(title, mod) {
      var col = h('div', 'sf-col');
      col.appendChild(h('div', 'sf-col-title', title));
      var wrap = h('div', 'sf-listwrap');
      var list = h('div', 'sf-list ' + mod);
      wrap.appendChild(list);
      wrap.appendChild(h('div', 'sf-list-fade'));
      col.appendChild(wrap);
      cols.appendChild(col);
      return list;
    }
    var wList = makeCol(C.widthTitle, 'sf-list--w');
    var lList = makeCol(C.lengthTitle, 'sf-list--l');

    var wBtns = {}, lBtns = {};

    widths.forEach(function (w) {
      var wrap = h('div', 'sf-item');
      var btn = h('button', 'sf-btn');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Ширина ' + fmt(w) + ' см');
      btn.appendChild(h('span', 'sf-val', fmt(w)));
      var badge = h('span', 'sf-badge');
      btn.appendChild(badge);
      wrap.appendChild(btn);
      wList.appendChild(wrap);
      wBtns[w] = { btn: btn, badge: badge, wrap: wrap };
      btn.addEventListener('click', function () { onWidthClick(w); });
    });

    lengths.forEach(function (l) {
      var wrap = h('div', 'sf-item');
      var btn = h('button', 'sf-btn');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Длина ' + fmt(l) + ' см');
      btn.appendChild(h('span', 'sf-val', fmt(l)));
      var count = h('span', 'sf-count');
      btn.appendChild(count);
      wrap.appendChild(btn);
      lList.appendChild(wrap);
      lBtns[l] = { btn: btn, count: count, wrap: wrap };
      btn.addEventListener('click', function () { onLengthClick(l); });
    });

    /* значения, не распознанные как ШxД, — обычными кнопками-тогглами */
    if (other.length) {
      var otherWrap = h('div', 'sf-other');
      otherWrap.appendChild(h('div', 'sf-col-title', C.otherTitle));
      var otherList = h('div', 'sf-other-list');
      other.forEach(function (it) {
        var btn = h('button', 'sf-btn sf-btn--other', it.raw);
        btn.type = 'button';
        otherList.appendChild(btn);
        // holder — чтобы после rebind() кнопка работала с новым чекбоксом
        var holder = { it: it };
        it._btn = btn;
        btn._sfHolder = holder;
        btn.addEventListener('click', function () {
          var cur = holder.it;
          if (!itemAvailable(cur)) return;
          toggleItem(cur);
        });
      });
      otherWrap.appendChild(otherList);
      inner.appendChild(otherWrap);
    }

    var foot = h('div', 'sf-popup-foot');
    var applyBtn = h('button', 'sf-apply', C.doneText);
    applyBtn.type = 'button';
    foot.appendChild(applyBtn);
    inner.appendChild(foot);

    var backdrop = h('div', 'sf-backdrop');

    /* ---------- открытие / закрытие попапа ---------- */

    var isOpen = false;

    function positionPopup() {
      if (isMobile()) {
        // мобильная шторка позиционируется чистым CSS
        popup.style.top = '';
        popup.style.left = '';
        popup.style.width = '';
        return;
      }
      var fr = fieldWrap.getBoundingClientRect();
      var br = box.getBoundingClientRect();
      var width = Math.min(C.popupWidth, window.innerWidth - 24);
      var left = fr.left - br.left;
      // не выпускаем панель за правый край экрана
      var overflowRight = (fr.left + width) - (window.innerWidth - 12);
      if (overflowRight > 0) left -= overflowRight;
      popup.style.top = (fr.bottom - br.top + 6) + 'px';
      popup.style.left = left + 'px';
      popup.style.width = width + 'px';
    }

    // Инстанс уничтожен ajax-перерисовкой (box заменён новым HTML):
    // снять свои document/window-слушатели, НЕ трогая mem.open / sf-lock /
    // классы — ими уже владеет новый инстанс. Иначе «протухший» слушатель
    // первым же кликом закрыл бы новый попап через общий mem.
    function detachIfDead() {
      if (document.body.contains(box)) return false;
      isOpen = false;
      document.removeEventListener('mousedown', onDocPointer, true);
      document.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('resize', onWinChange);
      window.removeEventListener('scroll', onWinChange, true);
      return true;
    }

    function onDocPointer(e) {
      if (detachIfDead()) return;
      if (popup.contains(e.target) || fieldWrap.contains(e.target)) return;
      closePopup();
    }

    function onKeydown(e) {
      if (detachIfDead()) return;
      if (e.key === 'Escape' || e.keyCode === 27) closePopup();
    }

    function onWinChange() {
      if (detachIfDead()) return;
      if (!isOpen) return;
      positionPopup();
      // пересечение мобильного порога при открытом попапе
      document.documentElement.classList.toggle('sf-lock', isMobile());
    }

    function openPopup() {
      if (isOpen) return;
      isOpen = true;
      mem.open = true;
      positionPopup();
      box.classList.add('sf-popup-open');
      popup.classList.add('sf-open');
      backdrop.classList.add('sf-open');
      field.setAttribute('aria-expanded', 'true');
      if (isMobile()) document.documentElement.classList.add('sf-lock');
      document.addEventListener('mousedown', onDocPointer, true);
      document.addEventListener('keydown', onKeydown, true);
      window.addEventListener('resize', onWinChange);
      window.addEventListener('scroll', onWinChange, true);
      // восстановление прокрутки колонок после ajax-перерисовки
      wList.scrollTop = mem.scrollW || 0;
      lList.scrollTop = mem.scrollL || 0;
      updateFades();
      try { popup.focus({ preventScroll: true }); } catch (e) { popup.focus(); }
    }

    function closePopup(silent) {
      if (detachIfDead()) return;
      if (!isOpen) return;
      isOpen = false;
      mem.open = false;
      box.classList.remove('sf-popup-open');
      popup.classList.remove('sf-open');
      popup.classList.remove('sf-no-anim');
      backdrop.classList.remove('sf-open');
      backdrop.classList.remove('sf-no-anim');
      field.setAttribute('aria-expanded', 'false');
      document.documentElement.classList.remove('sf-lock');
      document.removeEventListener('mousedown', onDocPointer, true);
      document.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('resize', onWinChange);
      window.removeEventListener('scroll', onWinChange, true);
      if (!silent) { try { field.focus(); } catch (e) { /* noop */ } }
    }

    field.addEventListener('click', function () {
      if (isOpen) { closePopup(); return; }
      // открытие пользователем — с анимацией
      popup.classList.remove('sf-no-anim');
      backdrop.classList.remove('sf-no-anim');
      openPopup();
    });
    closeBtn.addEventListener('click', function () { closePopup(); });
    applyBtn.addEventListener('click', function () { closePopup(); });
    backdrop.addEventListener('click', function () { closePopup(); });

    /* ---------- переключение чекбоксов ---------- */

    // Переключает чекбокс значения. Чекбокс переносится в персистентный
    // видимый якорь ВНУТРИ формы фильтра (fieldWrap / chipsRow / reset):
    // BX.pos() в smartFilter.click() вернёт координаты якоря, и всплывашка
    // «Показать N товаров» появится около поля, а не в углу страницы.
    // В сам попап и в чипсы (пересоздаются в renderAll) чекбокс не попадает —
    // иначе chips.innerHTML='' удалил бы его из документа и из формы.
    function toggleItem(it, anchorHost) {
      var host = anchorHost || fieldWrap;
      if (C.moveInputs && it.input.parentNode !== host) {
        host.appendChild(it.input);
      }
      it.input.click(); // переключает checked и вызывает smartFilter.click(this)
      renderAll();
    }

    function onWidthClick(w) {
      if (selL !== null) {
        // длину выбрали первой — клик по ширине завершает пару
        var it = comboAt(w, selL);
        if (it && it.input.checked) {
          // пара уже выбрана — не снимаем её, просто входим в контекст ширины
          selW = w; selL = null; remember();
          renderAll();
          return;
        }
        if (itemAvailable(it)) {
          selW = w; selL = null; remember();
          toggleItem(it);
          return; // toggleItem уже вызвал renderAll
        }
        // комбинации с ожидающей длиной нет, но кнопка ширины осталась
        // кликабельной из-за уже выбранных размеров этой ширины —
        // открываем ширину как контекст, чтобы их можно было снять
        selW = w; selL = null; remember();
        renderAll();
        return;
      }
      selW = (selW === w) ? null : w;
      remember();
      renderAll();
    }

    function onLengthClick(l) {
      if (selW !== null) {
        var it = comboAt(selW, l);
        if (itemAvailable(it)) toggleItem(it);
        return;
      }
      selL = (selL === l) ? null : l;
      remember();
      renderAll();
    }

    function resetAll() {
      var list = checkedItems();
      if (!list.length) return;
      // все, кроме последнего, снимаем тихо; последний — через click(),
      // чтобы ушёл один ajax-запрос с уже чистым состоянием формы
      for (var i = 0; i < list.length - 1; i++) list[i].input.checked = false;
      toggleItem(list[list.length - 1], reset);
    }

    /* ---------- отрисовка состояния ---------- */

    function chipLabel(it) {
      return it.size ? (fmt(it.size.w) + '×' + fmt(it.size.l)) : it.raw;
    }

    function renderAll() {
      var checked = checkedItems();

      // поле-триггер
      if (!checked.length) {
        fieldText.textContent = C.placeholder;
        fieldWrap.classList.remove('has-value');
      } else if (checked.length === 1) {
        fieldText.textContent = chipLabel(checked[0]);
        fieldWrap.classList.add('has-value');
      } else {
        fieldText.textContent = C.selectedText + ': ' + checked.length;
        fieldWrap.classList.add('has-value');
      }

      // чипсы выбранных размеров.
      // страховка: если чей-то чекбокс оказался внутри пересоздаваемого
      // списка — вернуть в исходный контейнер, иначе innerHTML='' удалит
      // его из документа и из формы умного фильтра
      Array.prototype.forEach.call(
        chipsList.querySelectorAll('input[type="checkbox"]'),
        function (inp) { container.appendChild(inp); }
      );
      chipsList.innerHTML = '';
      checked.forEach(function (it) {
        var chip = h('span', 'sf-chip');
        chip.appendChild(h('span', 'sf-chip-text', chipLabel(it)));
        var x = h('button', 'sf-chip-x');
        x.type = 'button';
        x.setAttribute('aria-label', 'Убрать размер ' + it.raw);
        x.innerHTML = '&times;';
        // якорь — персистентный chipsRow, а не сам чипс (чипсы пересоздаются)
        x.addEventListener('click', function () { toggleItem(it, chipsRow); });
        chip.appendChild(x);
        chipsList.appendChild(chip);
      });
      chipsRow.style.display = checked.length ? '' : 'none';
      reset.style.display = checked.length > 1 ? '' : 'none';
      hint.style.display = (selW === null && selL === null && !checked.length) ? '' : 'none';

      // колонка ширин
      widths.forEach(function (w) {
        var b = wBtns[w];
        var nChecked = 0;
        checked.forEach(function (it) {
          if (it.size && it.size.w === w) nChecked++;
        });
        var enabled;
        if (selL !== null) {
          enabled = itemAvailable(comboAt(w, selL));
        } else {
          enabled = lengths.some(function (l) { return itemAvailable(comboAt(w, l)); });
        }
        b.btn.disabled = !enabled && !nChecked;
        b.btn.classList.toggle('is-active', selW === w);
        b.btn.classList.toggle('has-checked', nChecked > 0);
        b.btn.setAttribute('aria-pressed', selW === w ? 'true' : 'false');
        b.badge.textContent = nChecked > 0 ? String(nChecked) : '';
      });

      // колонка длин
      lengths.forEach(function (l) {
        var b = lBtns[l];
        var it = (selW !== null) ? comboAt(selW, l) : null;
        var enabled, isChecked = false, cnt = NaN;
        if (selW !== null) {
          enabled = itemAvailable(it);
          isChecked = !!(it && it.input.checked);
          cnt = itemCount(it);
        } else {
          enabled = widths.some(function (w) { return itemAvailable(comboAt(w, l)); });
        }
        var hasCheckedAny = checked.some(function (c) { return c.size && c.size.l === l; });
        b.btn.disabled = !enabled;
        b.btn.classList.toggle('is-checked', selW !== null && isChecked);
        b.btn.classList.toggle('has-checked', selW === null && hasCheckedAny);
        b.btn.classList.toggle('is-active', selL === l);
        b.btn.setAttribute('aria-pressed', (isChecked || selL === l) ? 'true' : 'false');
        b.count.textContent =
          (C.showCounts && selW !== null && it && !isNaN(cnt)) ? String(cnt) : '';
      });

      // прочие значения
      other.forEach(function (it) {
        if (!it._btn) return;
        it._btn.classList.toggle('is-checked', it.input.checked);
        it._btn.setAttribute('aria-pressed', it.input.checked ? 'true' : 'false');
        it._btn.disabled = !itemAvailable(it);
      });

      quickHolders.forEach(function (holder) {
        var it = holder.it;
        var btn = holder.btn;
        if (!it || !btn) return;
        btn.classList.toggle('is-checked', it.input.checked);
        btn.setAttribute('aria-pressed', it.input.checked ? 'true' : 'false');
        btn.disabled = !itemAvailable(it);
      });

      // кнопка внизу попапа зеркалит битриксовую «Показать N товаров»
      var modefText = modefEl ? stripModef(modefEl.textContent) : '';
      applyBtn.textContent = modefText || C.doneText;

      updateFades();
    }

    function stripModef(s) {
      s = String(s || '').replace(/\s+/g, ' ').trim();
      return s;
    }

    /* градиент-подсказка «ниже есть ещё значения» */
    function updateFadeFor(list) {
      var wrap = list.parentNode;
      if (!wrap) return;
      var more = list.scrollHeight - list.scrollTop - list.clientHeight > 4;
      wrap.classList.toggle('has-more', more);
    }
    function updateFades() {
      updateFadeFor(wList);
      updateFadeFor(lList);
    }
    wList.addEventListener('scroll', function () {
      mem.scrollW = wList.scrollTop;
      updateFadeFor(wList);
    }, { passive: true });
    lList.addEventListener('scroll', function () {
      mem.scrollL = lList.scrollTop;
      updateFadeFor(lList);
    }, { passive: true });

    /* ---------- синхронизация с Битриксом ---------- */

    // Битрикс обновляет счётчики и класс disabled прямо в скрытых label,
    // а текст «Показать N товаров» — в modef; подхватываем эти изменения.
    // Вынесено в функцию: rebind() переподписывается на новый контейнер
    var syncMo = null;
    var syncScheduled = false;
    function observeSync() {
      if (!window.MutationObserver) return;
      if (syncMo) syncMo.disconnect();
      syncMo = new MutationObserver(function () {
        if (!document.body.contains(box)) return; // ждём rebind/гибель инстанса
        if (syncScheduled) return;
        syncScheduled = true;
        setTimeout(function () {
          syncScheduled = false;
          renderAll();
        }, 50);
      });
      syncMo.observe(container, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'disabled']
      });
      if (modefEl) {
        syncMo.observe(modefEl, { subtree: true, childList: true, characterData: true });
      }
    }
    observeSync();

    /* ---------- повторное использование пикера после ajax ---------- */

    // набор значений нового блока совпадает с текущим?
    function sameSets(newSized, newOther) {
      if (newSized.length !== sized.length || newOther.length !== other.length) return false;
      var i, key;
      // мультимножества ключей «w|l» должны совпасть точно (дубликаты —
      // например «80x190» и «80×190» — считаем поштучно)
      var oldKeys = {};
      sized.forEach(function (it) {
        key = sizeKey(it.size);
        oldKeys[key] = (oldKeys[key] || 0) + 1;
      });
      for (i = 0; i < newSized.length; i++) {
        key = sizeKey(newSized[i].size);
        if (!oldKeys[key]) return false;
        oldKeys[key]--;
      }
      var oldRaw = {};
      other.forEach(function (it) { oldRaw[it.raw] = (oldRaw[it.raw] || 0) + 1; });
      for (i = 0; i < newOther.length; i++) {
        if (!oldRaw[newOther[i].raw]) return false;
        oldRaw[newOther[i].raw]--;
      }
      return true;
    }

    // Переносит живые DOM-узлы пикера в новый (перерисованный ajax-ом) блок
    // и перепривязывает их к новым чекбоксам. Узлы не пересоздаются, поэтому
    // визуально ничего не меняется — обновляются только данные.
    function rebind(newBox, newBlock, newContainer, newSized, newOther) {
      if (document.body.contains(box)) return false; // старый блок ещё жив
      if (!sameSets(newSized, newOther)) return false;

      // повторная вставка узла перезапускает его CSS-анимацию —
      // на время открытости попапа держим animation:none
      if (isOpen) {
        popup.classList.add('sf-no-anim');
        backdrop.classList.add('sf-no-anim');
      }

      box = newBox;
      block = newBlock;
      container = newContainer;
      modefEl = box.querySelector('.bx_filter_container_modef');

      // выкидываем чекбоксы старого блока, перенесённые ранее в якоря:
      // новый контейнер содержит свежие инпуты с теми же id, дубликаты
      // сломали бы label[for] и BX(id) в постобработчике Битрикса
      Array.prototype.forEach.call(
        root.querySelectorAll('.sf-anchor-host > input[type="checkbox"]'),
        function (inp) { inp.parentNode.removeChild(inp); }
      );

      combos = {};
      newSized.forEach(function (it) { combos[sizeKey(it.size)] = it; });
      var pool = other.slice();
      newOther.forEach(function (it) {
        for (var i = 0; i < pool.length; i++) {
          if (pool[i] && pool[i].raw === it.raw) {
            it._btn = pool[i]._btn;
            if (it._btn && it._btn._sfHolder) it._btn._sfHolder.it = it;
            pool[i] = null;
            break;
          }
        }
      });
      quickHolders.forEach(function (holder) {
        var old = holder.it;
        if (!old || !old.size) return;
        var key = sizeKey(old.size);
        for (var qi = 0; qi < newSized.length; qi++) {
          if (sizeKey(newSized[qi].size) === key) {
            holder.it = newSized[qi];
            break;
          }
        }
      });
      sized = newSized;
      other = newOther;

      block.insertBefore(root, container);
      box.appendChild(popup);
      box.appendChild(backdrop);

      observeSync();

      // ориентируемся на mem.open, а не на isOpen: если перерисовка пришла
      // отложенно (rescan/onAjaxSuccess) и «мёртвые» слушатели уже успели
      // сняться через detachIfDead, попап нужно открыть заново — иначе на
      // мобильных остался бы sf-lock без видимой шторки
      if (mem.open) {
        if (!isOpen) {
          popup.classList.add('sf-no-anim');
          backdrop.classList.add('sf-no-anim');
          openPopup();
        } else {
          box.classList.add('sf-popup-open');
          wList.scrollTop = mem.scrollW || 0;
          lList.scrollTop = mem.scrollL || 0;
          positionPopup();
        }
      }
      renderAll();
      return true;
    }

    mem.inst = {
      getBox: function () { return box; },
      rebind: rebind
    };

    /* ---------- монтирование ---------- */

    block.insertBefore(root, container);
    box.appendChild(popup);
    box.appendChild(backdrop);

    renderAll();

    // попап был открыт до ajax-перерисовки — открываем снова,
    // чтобы пользователь продолжил выбирать размеры без лишних кликов.
    // sf-no-anim держим всё время, пока попап открыт: если снять класс,
    // animation:none сменится на имя анимации, и CSS перезапустит анимацию
    // появления с нуля — попап «моргнёт». Класс снимается при закрытии.
    if (mem.open) {
      popup.classList.add('sf-no-anim');
      backdrop.classList.add('sf-no-anim');
      openPopup();
    }
  }

  /* ---------- инициализация и повторная инициализация после ajax ---------- */

  function boxSelector(C, raw) {
    return C.propCodes.map(function (code) {
      return '.bx_filter_parameters_box[data-prop_code="' + code + '"]' +
        (raw ? ':not([data-sf-enhanced])' : '');
    }).join(',');
  }

  function enhanceAll() {
    var C = config();
    if (!C.propCodes || !C.propCodes.length) return;
    var boxes = document.querySelectorAll(boxSelector(C, false));
    Array.prototype.forEach.call(boxes, function (box) {
      try {
        enhance(box, C);
      } catch (e) {
        // упавший блок сразу возвращаем к штатному виду
        if (!box.classList.contains('sf-enhanced')) box.classList.add('sf-native');
        if (window.console && console.error) console.error('SizeFilter:', e);
      }
    });

    // блок с открытым попапом пропал из ajax-ответа или не пересобрался —
    // снять блокировку прокрутки, чтобы страница не осталась замороженной
    for (var pid in stateStore) {
      if (!stateStore[pid].open) continue;
      var b = document.querySelector(
        '.bx_filter_parameters_box[data-property_id="' + pid + '"],' +
        '.bx_filter_parameters_box[data-prop_code="' + pid + '"]'
      );
      if (!b || b.getAttribute('data-sf-enhanced') !== 'Y') releaseOpenState(pid);
    }

    armSafetyNet();
  }

  var rescan = debounce(enhanceAll, 60);

  // анти-FOUC: до инициализации прячем исходный список чекбоксов теми же
  // правилами, что и после (visually-hidden, без высоты) — сырой список не
  // мелькает и сайдбар не прыгает ни при загрузке, ни после ajax.
  // Если построить пикер не удалось, блоку возвращается видимость (sf-native).
  function injectPrehide(C) {
    var boxes = C.propCodes.map(function (code) {
      return '.bx_filter_parameters_box[data-prop_code="' + code + '"]' +
        ':not(.sf-enhanced):not(.sf-native)';
    });
    if (!boxes.length) return;
    var st = document.createElement('style');
    st.setAttribute('data-sf-prehide', '');
    st.textContent =
      boxes.map(function (b) { return b + ' .bx_filter_parameters_box_container'; }).join(',') +
      '{position:absolute !important;width:1px !important;height:1px !important;' +
      'overflow:hidden !important;clip:rect(0 0 0 0);margin:0 !important;padding:0 !important;}' +
      boxes.map(function (b) { return b + ' .inner_expand_text'; }).join(',') +
      '{display:none !important;}';
    (document.head || document.documentElement).appendChild(st);
  }

  // страховка: если через 4 секунды какой-то блок так и не инициализирован
  // (ошибка, отключённый JS-фрагмент и т.п.) — возвращаем ему штатный вид.
  // Перевзводится при каждом enhanceAll, т.е. и после каждого ajax.
  var safetyTimer = null;
  function armSafetyNet() {
    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = setTimeout(function () {
      safetyTimer = null;
      var C = config();
      var boxes = document.querySelectorAll(boxSelector(C, true));
      Array.prototype.forEach.call(boxes, function (box) {
        box.classList.add('sf-native');
      });
    }, 4000);
  }

  function boot() {
    enhanceAll();

    // фильтр в Аспро перерисовывается ajax-ом целиком — ловим появление
    // «сырых» блоков и инициализируемся заново. Важно: СИНХРОННО, прямо в
    // колбэке MutationObserver (он выполняется до отрисовки кадра) — тогда
    // браузер не успевает показать промежуточное состояние, и фильтр с
    // открытым попапом не мигает при каждом выборе размера
    if (window.MutationObserver) {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if ((n.matches && n.matches('.bx_filter_parameters_box:not([data-sf-enhanced])')) ||
                (n.querySelector && n.querySelector('.bx_filter_parameters_box:not([data-sf-enhanced])')) ||
                (n.closest && n.closest('.bx_filter_parameters_box:not([data-sf-enhanced])'))) {
              enhanceAll();
              return;
            }
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }

    if (window.BX && window.BX.addCustomEvent) {
      window.BX.addCustomEvent('onAjaxSuccess', rescan);
    }
  }

  var C0 = config();
  if (window.matchMedia) mqMobile = window.matchMedia(C0.mobileMedia);
  injectPrehide(C0);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
