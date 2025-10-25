// Усовершенствованное приложение торговой панели с расширенными фильтрами

// ✅ Конфигурация приложения
const CONFIG = {
  // Hyperliquid Vault settings
  VAULT_ADDRESS: "0x914434e8a235cb608a94a5f70ab8c40927152a24",
  HYPERLIQUID_API_ENDPOINT: "https://api.hyperliquid.xyz/info",

  // UI settings
  PAGE_SIZE: 40, // Размер пагинации для позиций
  OBSERVER_ROOT_MARGIN: "200px", // Margin для IntersectionObserver
};

// ✅ DEBUG утилита для контроля логирования
const DEBUG = {
  enabled: false, // Установить в true для включения логов
  log: (...args) => DEBUG.enabled && console.log("[DEBUG]", ...args),
  info: (...args) => DEBUG.enabled && console.info("[INFO]", ...args),
  warn: (...args) => DEBUG.enabled && console.warn("[WARN]", ...args),
  error: (...args) => console.error("[ERROR]", ...args), // Ошибки всегда выводятся
};

class TradingDashboard {
  normalizeCsvRow(row) {
    if (!row) return null;
    const sanitizeKey = (k) => String(k ?? "").replace(/^\uFEFF/, "");
    const g = (k) => {
      const k0 = sanitizeKey(k);
      return row[k0] ?? row[k0.toLowerCase?.()] ?? row[k0.toUpperCase?.()];
    };
    const trim = (v) => (typeof v === "string" ? v.trim() : v);
    const toNum = (v) => {
      if (typeof v === "number") return v;
      const s = String(v ?? "")
        .trim()
        .replace(/\s+/g, "")
        .replace(",", ".");
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };
    const out = {
      date_range: trim(g("date_range")),
      coin: trim(g("coin")),
      direction: trim(g("direction")),
      leverage: trim(g("leverage")),
      volume_with_leverage: toNum(g("volume_with_leverage")),
      margin: toNum(g("margin")),
      unrealized_pnl: toNum(g("unrealized_pnl")),
      fee: toNum(g("fee")),
      funding: toNum(g("funding")),
      pnl: toNum(g("pnl")),
      duration: (function () {
        return String(g("duration") ?? g("duration ") ?? "").trim();
      })(),
    };
    if (!out.date_range || !out.coin) return null;
    out.parsedDates = this.parseDateRange?.(out.date_range) || null;
    return out;
  }

  dedupeByKey(items, keyFn) {
    const seen = new Set();
    const result = [];
    for (const it of items) {
      const k = keyFn(it);
      if (seen.has(k)) continue;
      seen.add(k);
      result.push(it);
    }
    return result;
  }

  async tryLoadCsvFromServer() {
    const candidates = [
      "trading_data.csv",
      "./trading_data.csv",
      "data/trading_data.csv",
      "./data/trading_data.csv",
    ];

    const tryOne = async (url) => {
      const u = url + (url.includes("?") ? "&" : "?") + "ts=" + Date.now();
      const res = await fetch(u, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
      const text = await res.text();

      if (
        typeof Papa !== "undefined" &&
        Papa &&
        typeof Papa.parse === "function"
      ) {
        const parsed = Papa.parse(text, {
          header: true,
          skipEmptyLines: true,
          dynamicTyping: true,
          transformHeader: (h) =>
            String(h || "")
              .replace(/^\uFEFF/, "")
              .trim()
              .toLowerCase(),
        });
        return Array.isArray(parsed.data) ? parsed.data : [];
      }

      const lines = text.trim().split(/\r?\n/);
      if (!lines.length) return [];
      const first = lines.shift().replace(/^\uFEFF/, "");
      const sep = first.includes(";") ? ";" : ",";
      const headers = first.split(sep).map((h) =>
        h
          .replace(/^\uFEFF/, "")
          .trim()
          .toLowerCase()
      );
      return lines.map((line) => {
        const cells = line.replace(/^\uFEFF/, "").split(sep);
        const obj = {};
        headers.forEach((h, i) => (obj[h] = cells[i]));
        return obj;
      });
    };

    let rows = [];
    let lastErr = null;

    if (location.protocol === "file:") {
      DEBUG.warn(
        "[CSV] Открыт через file:// — браузер может блокировать fetch. " +
          "Запусти локальный сервер, например: python -m http.server 8000"
      );
    }

    for (const url of candidates) {
      try {
        rows = await tryOne(url);
        if (rows && rows.length) {
          DEBUG.info(`[CSV] Загружено из: ${url} (строк: ${rows.length})`);
          break;
        } else {
          DEBUG.warn(`[CSV] Пустой CSV: ${url}`);
        }
      } catch (e) {
        lastErr = e;
        DEBUG.warn(`[CSV] Не удалось: ${url} → ${e?.message || e}`);
      }
    }

    if (!rows || !rows.length) {
      if (lastErr) DEBUG.error("[CSV] Последняя ошибка:", lastErr);
      return false;
    }

    const normalized = rows.map((r) => this.normalizeCsvRow(r)).filter(Boolean);
    const deduped = this.dedupeByKey(normalized, (r) =>
      [r.date_range, r.coin, r.direction, r.leverage, r.margin].join("|")
    );
    this.tradingData = deduped;
    return this.tradingData.length > 0;
  }

  constructor() {
    this.tradingData = [];
    this.filteredData = [];
    this.sortBy = "date-asc";
    this.filters = {
      year: null,
      month: null,
      crypto: null,
      leverage: null,
      direction: null,
    };
    // Кэш форматтера валюты и цветов графиков
    this.fmtUSD = new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    this.readChartUI = () => {
      const css = getComputedStyle(document.documentElement);
      return {
        border: css.getPropertyValue("--chart-border").trim(),
        tick: css.getPropertyValue("--chart-tick").trim(),
        grid: css.getPropertyValue("--chart-grid").trim(),
        legendText: css.getPropertyValue("--chart-legend-text").trim(),
      };
    };
    this.ui = this.readChartUI();
    // параметры дозагрузки карточек
    this.pageSize = CONFIG.PAGE_SIZE;
    this.pageIndex = 0;
    this.sortedForRender = [];
    this.monthsRussian = {
      1: "Январь",
      2: "Февраль",
      3: "Март",
      4: "Апрель",
      5: "Май",
      6: "Июнь",
      7: "Июль",
      8: "Август",
      9: "Сентябрь",
      10: "Октябрь",
      11: "Ноябрь",
      12: "Декабрь",
    };

    const VARS_BY_TICKER = {
      BTC: "--coin-btc",
      ETH: "--coin-eth",
      HYPE: "--coin-hype",
      SOL: "--coin-sol",
      BNB: "--coin-bnb",
      XRP: "--coin-xrp",
      ADA: "--coin-ada",
      DOGE: "--coin-doge",
      TON: "--coin-ton",
      LTC: "--coin-ltc",
      AVAX: "--coin-avax",
      TRX: "--coin-trx",
      MATIC: "--coin-matic",
      LINK: "--coin-link",
      BCH: "--coin-bch",
      ARB: "--coin-arb",
      OP: "--coin-op",
      UNI: "--coin-uni",
      WIF: "--coin-wif",
      PENDLE: "--coin-pendle",
    };

    // Небольшие алиасы (если прилетят альтернативные тикеры)
    const TICKER_ALIASES = {
      POL: "MATIC",
    };

    const readCssVars = () => {
      const css = getComputedStyle(document.documentElement);
      const cssVar = (name) => css.getPropertyValue(name).trim();
      const coinDefault = cssVar("--coin-default");
      const coinColors = {};

      for (const [ticker, varName] of Object.entries(VARS_BY_TICKER)) {
        coinColors[ticker] = cssVar(varName) || coinDefault;
      }

      // опционально: массив базовой палитры для графиков
      const chartColors = Array.from({ length: 20 }, (_, i) => {
        const v = cssVar(`--chart-${i + 1}`).trim();
        return v || coinDefault;
      });

      return { coinColors, coinDefault, chartColors };
    };

    // Инициализация
    {
      const { coinColors, coinDefault, chartColors } = readCssVars();

      this.coinColors = coinColors; // { BTC: 'hsl(...)', ETH: 'hsl(...)', ... }
      this.coinDefault = coinDefault; // 'hsl(...)'
      this.chartColors = chartColors; // ['hsl(...)', 'hsl(...)', ...]

      // Утилита получения цвета по тикеру с fallback
      this.getCoinColor = (symbol) => {
        if (!symbol) return this.coinDefault;
        const up = String(symbol).toUpperCase().trim();
        const norm = TICKER_ALIASES[up] || up;
        return this.coinColors[norm] || this.coinDefault;
      };

      this.charts = this.charts || {};

      // Авто-обновление при смене темы (data-theme на <html>)
      const observer = new MutationObserver(() => {
        const { coinColors, coinDefault, chartColors } = readCssVars();
        this.coinColors = coinColors;
        this.coinDefault = coinDefault;
        this.chartColors = chartColors;

        // Если у чартов есть метод перекраски — обновим (no-op, если нет)
        Object.values(this.charts).forEach((c) =>
          c?.updateColors?.(this.getCoinColor, this.chartColors)
        );
      });

      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });

      this.init();
    }

    document.addEventListener("themechange", () => {
      this.ui = this.readChartUI();
      this.updateCharts();
      this.updateCoinTitleColors?.();
    });
  }

  init() {
    this.tryLoadCsvFromServer()
      .then((loaded) => {
        if (loaded) {
          this.setupEventListeners();
          this.populateAllFilters();
          this.applyFilters();
        } else {
          this.tradingData = [];
          this.showNoData();
        }
      })
      .catch((err) => {
        DEBUG.error("CSV load error:", err);
        this.tradingData = [];
        this.showNoData();
      })
      .finally(() => {
        // Инициализируем Hyperliquid Vault виджет независимо от загрузки CSV
        this.initVaultWidget();
      });
  }

  parseDateRange(dateRange) {
    try {
      const [startDateStr, endDateStr] = dateRange.split(/\s*-\s*/);
      const [startDay, startMonth, startYear] = startDateStr
        .split(".")
        .map(Number);
      const [endDay, endMonth, endYear] = endDateStr.split(".").map(Number);

      return {
        startDate: new Date(startYear, startMonth - 1, startDay),
        endDate: new Date(endYear, endMonth - 1, endDay),
        year: startYear,
        month: startMonth,
      };
    } catch (error) {
      DEBUG.error("Error parsing date range:", dateRange, error);
      return null;
    }
  }

  setupEventListeners() {
    // Прослушиваем изменения в фильтрах
    const yearSel = document.getElementById("year-select");
    yearSel &&
      yearSel.addEventListener("change", (e) => {
        this.filters.year = e.target.value ? parseInt(e.target.value) : null;
        this.populateMonthFilter();
        this.applyFilters();
      });

    const monthSel = document.getElementById("month-select");
    monthSel &&
      monthSel.addEventListener("change", (e) => {
        this.filters.month = e.target.value ? parseInt(e.target.value) : null;
        this.applyFilters();
      });

    const cryptoSel = document.getElementById("crypto-select");
    cryptoSel &&
      cryptoSel.addEventListener("change", (e) => {
        this.filters.crypto = e.target.value || null;
        this.applyFilters();
      });

    const leverageSel = document.getElementById("leverage-select");
    leverageSel &&
      leverageSel.addEventListener("change", (e) => {
        this.filters.leverage = e.target.value || null;
        this.applyFilters();
      });

    const directionSel = document.getElementById("direction-select");
    directionSel &&
      directionSel.addEventListener("change", (e) => {
        this.filters.direction = e.target.value || null;
        this.applyFilters();
      });

    const sortSel = document.getElementById("sort-by");
    if (sortSel) {
      sortSel.addEventListener("change", () => {
        this.sortBy = sortSel.value || "";
        this.updatePositions();
      });
    }

    // Кнопка "Сбросить фильтры"
    const resetBtn = document.getElementById("reset-filters");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => this.resetAllFilters());
    } else {
      DEBUG.warn(
        '[UI] Кнопка "Сбросить фильтры" не найдена — обработчик не привязан'
      );
    }
    // Мини-меню сортировок
    const sortBtn = document.getElementById("sort-menu-button");
    const sortMenu = document.getElementById("sort-menu");
    if (sortBtn && sortMenu) {
      const items = Array.from(sortMenu.querySelectorAll(".sort-item"));

      const openMenu = () => {
        sortMenu.hidden = false;
        sortBtn.setAttribute("aria-expanded", "true");
        const active =
          items.find((i) => i.getAttribute("aria-checked") === "true") ||
          items[0];
        active.focus();
        document.addEventListener("click", onDocClick, { capture: true });
        document.addEventListener("keydown", onKeydown);
      };
      const closeMenu = () => {
        sortMenu.hidden = true;
        sortBtn.setAttribute("aria-expanded", "false");
        document.removeEventListener("click", onDocClick, { capture: true });
        document.removeEventListener("keydown", onKeydown);
        sortBtn.focus();
      };
      const onDocClick = (e) => {
        if (!sortMenu.contains(e.target) && e.target !== sortBtn) closeMenu();
      };
      const onKeydown = (e) => {
        const idx = items.indexOf(document.activeElement);
        if (e.key === "Escape") {
          e.preventDefault();
          closeMenu();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          (items[idx + 1] || items[0]).focus();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          (items[idx - 1] || items[items.length - 1]).focus();
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          document.activeElement?.click();
        }
      };
      const applySort = (value) => {
        this.sortBy = value || "";
        items.forEach((btn) =>
          btn.setAttribute(
            "aria-checked",
            String(btn.dataset.sort === this.sortBy)
          )
        );
        this.updatePositions();
      };

      sortBtn.addEventListener("click", () => {
        const expanded = sortBtn.getAttribute("aria-expanded") === "true";
        expanded ? closeMenu() : openMenu();
      });
      items.forEach((btn) => {
        btn.addEventListener("click", () => {
          applySort(btn.dataset.sort || "");
          closeMenu();
        });
      });
      applySort(this.sortBy);
    }
  }

  populateAllFilters() {
    this.populateYearFilter();
    this.populateCryptoFilter();
    this.populateLeverageFilter();
    this.populateMonthFilter();
  }

  populateYearFilter() {
    const yearSelect = document.getElementById("year-select");
    if (!yearSelect) return;
    const years = [
      ...new Set(
        this.tradingData
          .map((item) => item.parsedDates?.year)
          .filter((y) => Number.isFinite(y))
      ),
    ].sort((a, b) => b - a);

    yearSelect.innerHTML = '<option value="">Все годы</option>';
    years.forEach((year) => {
      const option = document.createElement("option");
      option.value = year;
      option.textContent = year;
      yearSelect.appendChild(option);
    });
  }

  populateMonthFilter() {
    const monthSelect = document.getElementById("month-select");
    monthSelect.innerHTML = '<option value="">Все месяцы</option>';

    if (!this.filters.year) {
      monthSelect.disabled = true;
      return;
    }

    const months = [
      ...new Set(
        this.tradingData
          .filter((item) => item.parsedDates?.year === this.filters.year)
          .map((item) => item.parsedDates?.month)
          .filter((m) => Number.isFinite(m))
      ),
    ].sort((a, b) => a - b);

    months.forEach((month) => {
      const option = document.createElement("option");
      option.value = month;
      option.textContent = this.monthsRussian[month.toString()];
      monthSelect.appendChild(option);
    });

    monthSelect.disabled = false;
  }

  populateCryptoFilter() {
    const cryptoSelect = document.getElementById("crypto-select");
    const cryptos = [
      ...new Set(this.tradingData.map((item) => item.coin)),
    ].sort();

    cryptoSelect.innerHTML = '<option value="">Все активы</option>';
    cryptos.forEach((crypto) => {
      const option = document.createElement("option");
      option.value = crypto;
      option.textContent = crypto;
      cryptoSelect.appendChild(option);
    });
  }

  populateLeverageFilter() {
    const leverageSelect = document.getElementById("leverage-select");
    const leverages = [
      ...new Set(this.tradingData.map((item) => item.leverage)),
    ].sort((a, b) => {
      const ax = (a || "").toString();
      const bx = (b || "").toString();
      const aNum = parseInt(ax.replace(/x/i, ""), 10) || 0;
      const bNum = parseInt(bx.replace(/x/i, ""), 10) || 0;
      return aNum - bNum;
    });

    leverageSelect.innerHTML = '<option value="">Все плечи</option>';
    leverages.forEach((leverage) => {
      const option = document.createElement("option");
      option.value = leverage;
      option.textContent = leverage;
      leverageSelect.appendChild(option);
    });
  }

  applyFilters() {
    // Фильтр данных по выбранным параметрам
    this.filteredData = this.tradingData.filter((item) => {
      if (this.filters.year && item.parsedDates?.year !== this.filters.year) {
        return false;
      }

      if (
        this.filters.month &&
        item.parsedDates?.month !== this.filters.month
      ) {
        return false;
      }

      if (this.filters.crypto && item.coin !== this.filters.crypto) {
        return false;
      }

      if (this.filters.leverage && item.leverage !== this.filters.leverage) {
        return false;
      }

      if (this.filters.direction && item.direction !== this.filters.direction) {
        return false;
      }

      return true;
    });

    DEBUG.log("Applied filters:", this.filters);
    DEBUG.log("Filtered data count:", this.filteredData.length);

    this.updateActiveFiltersDisplay();
    this.updateDashboard();
  }

  updateActiveFiltersDisplay() {
    const anyActive = Object.values(this.filters).some(Boolean);
    let activeFiltersContainer = document.getElementById("active-filters");

    // Если фильтров нет — удаляем live-область и выходим
    if (!anyActive) {
      if (activeFiltersContainer) activeFiltersContainer.remove();
      return;
    }

    // Если области ещё нет — создаём и вставляем перед #more-filters
    if (!activeFiltersContainer) {
      activeFiltersContainer = document.createElement("div");
      activeFiltersContainer.id = "active-filters";
      activeFiltersContainer.className = "active-filters";
      activeFiltersContainer.setAttribute("role", "status"); // = aria-live="polite"
      activeFiltersContainer.setAttribute("aria-live", "polite");
      activeFiltersContainer.setAttribute("aria-atomic", "true");
      const container = document.querySelector("#filters .filters-container");
      const more = document.getElementById("more-filters");
      container && more
        ? container.insertBefore(activeFiltersContainer, more)
        : container?.appendChild(activeFiltersContainer);
    }
    activeFiltersContainer.innerHTML = "";
    const filterLabels = {
      year: "Год",
      month: "Месяц",
      crypto: "Актив",
      leverage: "Плечо",
      direction: "Направление",
    };

    Object.keys(this.filters).forEach((filterKey) => {
      const filterValue = this.filters[filterKey];
      if (filterValue) {
        const tag = document.createElement("div");
        tag.className = "filter-tag";

        let displayValue = filterValue;
        if (filterKey === "month") {
          displayValue = this.monthsRussian[filterValue.toString()];
        } else if (filterKey === "direction") {
          displayValue = filterValue === "Long" ? "Лонг" : "Шорт";
        }

        const span = document.createElement("span");
        span.textContent = `${filterLabels[filterKey]}: ${displayValue}`;
        const btn = document.createElement("button");
        btn.className = "filter-tag-remove";
        btn.type = "button";
        btn.setAttribute("data-filter", String(filterKey));
        btn.textContent = "×";
        tag.append(span, btn);
        tag
          .querySelector(".filter-tag-remove")
          .addEventListener("click", () => {
            this.removeFilter(filterKey);
          });

        activeFiltersContainer.appendChild(tag);
      }
    });

    // Скрытая сводка для скринридеров: читается одной фразой
    const parts = [];
    if (this.filters.year) parts.push(`Год: ${this.filters.year}`);
    if (this.filters.month)
      parts.push(`Месяц: ${this.monthsRussian[this.filters.month.toString()]}`);
    if (this.filters.crypto) parts.push(`Актив: ${this.filters.crypto}`);
    if (this.filters.leverage) parts.push(`Плечо: ${this.filters.leverage}`);
    if (this.filters.direction)
      parts.push(
        `Направление: ${this.filters.direction === "Long" ? "Лонг" : "Шорт"}`
      );
    const summary = `Применены фильтры — ${parts.join(", ")}. Показано ${
      this.filteredData.length
    } из ${this.tradingData.length}.`;
    const sr = document.createElement("p");
    sr.className = "visually-hidden";
    sr.textContent = summary;
    activeFiltersContainer.appendChild(sr);
  }

  removeFilter(filterKey) {
    this.filters[filterKey] = null;

    const selectElement = document.getElementById(
      `${filterKey === "crypto" ? "crypto" : filterKey}-select`
    );
    if (selectElement) {
      selectElement.value = "";
    }

    if (filterKey === "year") {
      this.filters.month = null;
      const monthSelect = document.getElementById("month-select");
      monthSelect.value = "";
      monthSelect.disabled = true;
    }

    if (filterKey === "year") {
      this.populateMonthFilter();
    }

    this.applyFilters();
  }

  resetAllFilters() {
    // Сброс всех фильтров
    Object.keys(this.filters).forEach((key) => {
      this.filters[key] = null;
    });

    document.getElementById("year-select").value = "";
    document.getElementById("month-select").value = "";
    document.getElementById("crypto-select").value = "";
    document.getElementById("leverage-select").value = "";
    document.getElementById("direction-select").value = "";
    document.getElementById("month-select").disabled = true;

    this.applyFilters();
    // Объявляем сброс в постоянной live-зоне
    const srStatus = document.getElementById("filters-status");
    if (srStatus) {
      srStatus.textContent = "Фильтры сброшены. Показаны все позиции.";
    }
  }

  updateDashboard() {
    if (this.filteredData.length === 0) {
      this.showNoData();
      return;
    }

    this.showMainContent();
    this.updateStats();
    this.updateCharts();
    this.updatePositions();
    this.updatePositionCounts();
  }
  updateCoinTitleColors() {
    document.querySelectorAll(".coin-symbol").forEach((el) => {
      const coin = el.dataset.coin || el.textContent.trim();
      el.style.color = this.getCoinColor(coin);
    });
  }
  showMainContent() {
    const mainContent = document.getElementById("main-content");
    const noDataMessage = document.getElementById("no-data-message");

    if (mainContent) mainContent.style.display = "block";
    if (noDataMessage) noDataMessage.style.display = "none";
  }

  showNoData() {
    const mainContent = document.getElementById("main-content");
    const noDataMessage = document.getElementById("no-data-message");

    if (mainContent) mainContent.style.display = "none";
    if (noDataMessage) noDataMessage.style.display = "flex";
  }

  updatePositionCounts() {
    const filteredCount = document.getElementById("filtered-count");
    const totalCount = document.getElementById("total-count");

    if (filteredCount) filteredCount.textContent = this.filteredData.length;
    if (totalCount) totalCount.textContent = this.tradingData.length;
  }

  updateStats() {
    const anyFilterActive =
      Object.values(this.filters).some(Boolean) ||
      (this.filteredData &&
        this.tradingData &&
        this.filteredData.length !== this.tradingData.length);

    const data = anyFilterActive
      ? this.filteredData || this.tradingData
      : this.tradingData;

    // ✅ Оптимизация: один проход вместо 5 (80% faster)
    const stats = data.reduce(
      (acc, r) => {
        const pnl = Number(r.pnl) || 0;
        acc.totalPnl += pnl;
        acc.totalMargin += Number(r.margin) || 0;
        if (pnl > 0) acc.wins++;
        acc.fees += Number(r.fee) || 0;
        acc.funding += Number(r.funding) || 0;
        return acc;
      },
      { totalPnl: 0, totalMargin: 0, wins: 0, fees: 0, funding: 0 }
    );

    const totalPnl = stats.totalPnl;
    const winningPositions = stats.wins;
    const sumFees = stats.fees;
    const sumFunding = stats.funding;
    // Требование: "Общие комиссии" считаем ТОЛЬКО по fee (без funding)
    const totalFees = sumFees;
    const totalPnlElement = document.getElementById("total-pnl");
    const totalPnlPercentElement = document.getElementById("total-pnl-percent");
    const winRateElement = document.getElementById("win-rate");
    const totalPositionsElement = document.getElementById("total-positions");
    const totalFeesElement = document.getElementById("total-fees");
    const totalFundingElement = document.getElementById("total-funding");
    const totalGrossPnlElement = document.getElementById("total-gross-pnl");
    if (totalPnlElement) {
      totalPnlElement.textContent = this.formatCurrency(totalPnl);
      totalPnlElement.title = anyFilterActive
        ? "Сумма PnL по отфильтрованным записям"
        : "Сумма PnL по всем записям CSV";
    }

    if (totalPnlPercentElement) {
      totalPnlPercentElement.remove();
    }

    if (winRateElement) {
      winRateElement.textContent = String(winningPositions);
      winRateElement.title = "Количество успешных позиций";
    }
    if (totalPositionsElement)
      totalPositionsElement.textContent = String(data.length);
    if (totalFeesElement) {
      const fmt = (v) => this.formatCurrency(v);
      totalFeesElement.textContent = fmt(totalFees);
      totalFeesElement.title = `Σ fee: ${fmt(sumFees)}`;
    }
    // Новая карточка: общий фандинг
    if (totalFundingElement) {
      const fmt = (v) =>
        this.formatCurrency
          ? this.formatCurrency(v)
          : v.toLocaleString(undefined, {
              style: "currency",
              currency: "USD",
              maximumFractionDigits: 0,
            });
      totalFundingElement.textContent = fmt(sumFunding);
      totalFundingElement.title = `Σ funding: ${fmt(sumFunding)}`;
    }
    if (totalGrossPnlElement) {
      const totalGross = totalPnl + sumFees;
      const fmt = (v) => this.formatCurrency(v);
      totalGrossPnlElement.textContent = fmt(totalGross);
      totalGrossPnlElement.title = `Net PnL: ${fmt(totalPnl)} + Σ fee: ${fmt(
        sumFees
      )} = Gross: ${fmt(totalGross)}`;
    }
    DEBUG.log(
      "Updated stats - PnL:",
      totalPnl,
      "Wins:",
      winningPositions,
      "Positions:",
      data.length
    );
  }
  /**
   * Render accessible data table for a chart
   * @param {string} chartId - base id, e.g. 'pnl-chart'
   * @param {Array<string>} headers - table headers
   * @param {Array<Array<string|number>>} rows - rows data
   */
  renderChartTable(chartId, headers, rows) {
    const table = document.getElementById(chartId + "-data");
    if (!table) return;
    const thead = table.querySelector("thead");
    const tbody = table.querySelector("tbody");
    if (!thead || !tbody) return;
    thead.innerHTML = "";
    const trHead = document.createElement("tr");
    headers.forEach((h) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = h;
      trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    tbody.innerHTML = "";
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      r.forEach((cell) => {
        const td = document.createElement("td");
        td.textContent = String(cell);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }
  updateCharts() {
    this.createPnLChart();
    this.createPerformanceChart();
  }

  createPnLChart() {
    const canvas = document.getElementById("pnl-chart");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");

    if (this.charts.pnl) {
      this.charts.pnl.destroy();
    }

    const pnlByCoin = {};
    this.filteredData.forEach((item) => {
      pnlByCoin[item.coin] = (pnlByCoin[item.coin] || 0) + item.pnl;
    });

    const labels = Object.keys(pnlByCoin);
    const data = Object.values(pnlByCoin);
    const colors = labels.map(
      (coin) => this.coinColors[coin] || this.coinDefault
    );
    const small = window.matchMedia("(max-width: 560px)").matches;
    const tiny = window.matchMedia("(max-width: 380px)").matches;
    this.charts.pnl = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: labels,
        datasets: [
          {
            data: data,
            backgroundColor: colors,
            borderWidth: 2,
            borderColor: this.ui.border,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        radius: small ? "95%" : "90%", // больше занимаемой площади
        cutout: small ? "40%" : "45%", // толще кольцо = визуально крупнее
        layout: { padding: small ? 4 : 8 }, // минимум внутренних отступов
        normalized: true,
        animation: { duration: 0 },
        plugins: {
          legend: {
            display: !tiny, // на очень узких скрываем
            position: "bottom",
            labels: {
              color: this.ui.legendText,
              padding: 12,
              boxWidth: 10,
              boxHeight: 10,
              font: { size: small ? 11 : 12 },
            },
          },
          tooltip: {
            callbacks: {
              label: (context) => {
                const value = context.parsed;
                return `${context.label}: ${this.formatCurrency(value)}`;
              },
            },
          },
        },
      },
    });
    // Render data table for screen readers / data view
    this.renderChartTable(
      "pnl-chart",
      ["Актив", "PnL"],
      labels.map((label, i) => [label, this.formatCurrency(data[i])])
    );
  }

  createPerformanceChart() {
    const canvas = document.getElementById("performance-chart");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");

    if (this.charts.performance) {
      this.charts.performance.destroy();
    }

    const performanceByCoin = {};
    this.filteredData.forEach((item) => {
      if (!performanceByCoin[item.coin]) {
        performanceByCoin[item.coin] = { wins: 0, total: 0 };
      }
      performanceByCoin[item.coin].total++;
      if (item.pnl > 0) {
        performanceByCoin[item.coin].wins++;
      }
    });

    const labels = Object.keys(performanceByCoin);
    const winCounts = labels.map((coin) => performanceByCoin[coin].wins);
    const maxWins = Math.max(1, ...winCounts);
    const colors = labels.map(
      (coin) => this.coinColors[coin] || this.coinDefault
    );

    this.charts.performance = new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          {
            label: "Успешные сделки",
            data: winCounts,
            backgroundColor: colors,
            borderWidth: 0,
            borderRadius: 4,
            borderSkipped: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: 8 },
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            callbacks: {
              label: (context) => {
                const coin = context.label;
                const wins = context.parsed.y;
                const stats = performanceByCoin[coin];
                return `${coin}: Успешных сделок ${wins} (из ${stats.total})`;
              },
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              color: this.ui.tick,
              stepSize: 1, // только целые значения
              precision: 0,
              callback: (v) => (Number.isInteger(v) ? v : ""), // страховка
            },
            suggestedMax: maxWins, // адекватный верх шкалы
            grid: { color: this.ui.grid },
          },
          x: { ticks: { color: this.ui.tick }, grid: { display: false } },
        },
      },
    });
    // Render data table for screen readers / data view
    this.renderChartTable(
      "performance-chart",
      ["Актив", "Успешных", "Всего", "Win rate"],
      labels.map((coin) => {
        const stats = performanceByCoin[coin];
        const rate = stats.total
          ? Math.round((stats.wins / stats.total) * 100) + "%"
          : "—";
        return [coin, stats.wins, stats.total, rate];
      })
    );
  }
  getSortedData(data) {
    const arr = Array.isArray(data) ? [...data] : [];
    const getStart = (x) => x?.parsedDates?.startDate ?? 0;

    switch (this.sortBy) {
      case "date-asc": // старые → новые
        arr.sort((a, b) => getStart(a) - getStart(b));
        break;

      case "date-desc": // новые → старые
        arr.sort((a, b) => getStart(b) - getStart(a));
        break;

      case "pnl-asc": // PnL ↑ ; тай-брейк — новые выше
        arr.sort((a, b) => {
          const d = (Number(a.pnl) || 0) - (Number(b.pnl) || 0);
          return d !== 0 ? d : getStart(b) - getStart(a);
        });
        break;

      case "pnl-desc": // PnL ↓ ; тай-брейк — новые выше
        arr.sort((a, b) => {
          const d = (Number(b.pnl) || 0) - (Number(a.pnl) || 0);
          return d !== 0 ? d : getStart(b) - getStart(a);
        });
        break;

      case "coin-asc": // Актив A→Z ; тай-брейк — PnL ↓
        arr.sort((a, b) => {
          const an = (a.coin ?? "").toString();
          const bn = (b.coin ?? "").toString();
          const d = an.localeCompare(bn, undefined, {
            sensitivity: "base",
            numeric: true,
          });
          return d !== 0 ? d : (Number(b.pnl) || 0) - (Number(a.pnl) || 0);
        });
        break;

      case "coin-desc": // Актив Z→A ; тай-брейк — PnL ↓
        arr.sort((a, b) => {
          const an = (a.coin ?? "").toString();
          const bn = (b.coin ?? "").toString();
          const d = bn.localeCompare(an, undefined, {
            sensitivity: "base",
            numeric: true,
          });
          return d !== 0 ? d : (Number(b.pnl) || 0) - (Number(a.pnl) || 0);
        });
        break;

      case "direction-short-first": // сперва Short, внутри — PnL ↓
        arr.sort((a, b) => {
          const ad = (a.direction ?? "").toLowerCase();
          const bd = (b.direction ?? "").toLowerCase();
          if (ad === bd) return (Number(b.pnl) || 0) - (Number(a.pnl) || 0);
          if (ad === "short") return -1;
          if (bd === "short") return 1;
          return 0;
        });
        break;

      case "direction-long-first": // сперва Long, внутри — PnL ↓
        arr.sort((a, b) => {
          const ad = (a.direction ?? "").toLowerCase();
          const bd = (b.direction ?? "").toLowerCase();
          if (ad === bd) return (Number(b.pnl) || 0) - (Number(a.pnl) || 0);
          if (ad === "long") return -1;
          if (bd === "long") return 1;
          return 0;
        });
        break;
      default:
        // По умолчанию — по дате от старых к новым
        break;
    }
    return arr;
  }
  updatePositions() {
    const positionsGrid = document.getElementById("positions-grid");
    if (!positionsGrid) return;
    positionsGrid.innerHTML = "";

    this.sortedForRender = this.getSortedData(this.filteredData);
    this.pageIndex = 0;

    const renderChunk = () => {
      const start = this.pageIndex * this.pageSize;
      const end = Math.min(start + this.pageSize, this.sortedForRender.length);
      for (let i = start; i < end; i++) {
        const positionCard = this.createPositionCard(this.sortedForRender[i]);
        positionsGrid.appendChild(positionCard);
      }
      this.pageIndex++;
      if (
        end >= this.sortedForRender.length &&
        sentinel &&
        sentinel.parentNode
      ) {
        this.positionsObserver && this.positionsObserver.disconnect();
        sentinel.remove();
      }
    };

    // sentinel для дозагрузки при прокрутке
    const sentinel = document.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.style.height = "1px";
    positionsGrid.appendChild(sentinel);

    // ✅ Очищаем предыдущий observer если есть
    if (this.positionsObserver) {
      this.positionsObserver.disconnect();
    }

    this.positionsObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            renderChunk();
          }
        });
      },
      { root: null, rootMargin: CONFIG.OBSERVER_ROOT_MARGIN, threshold: 0 }
    );

    this.positionsObserver.observe(sentinel);
    renderChunk(); // первый батч
  }
  createPositionCard(position) {
    const card = document.createElement("div");
    card.className = "card card--position";
    const body = document.createElement("div");
    body.className = "card__body";
    const header = document.createElement("div");
    header.className = "position-header";
    const info = document.createElement("div");
    info.className = "coin-info";
    const sym = document.createElement("div");
    sym.dataset.coin = String(position.coin || "");
    sym.style.color = this.getCoinColor(position.coin);
    sym.className = "coin-symbol";
    sym.textContent = String(position.coin || "");
    const name = document.createElement("div");
    name.className = "coin-name";
    name.textContent = String(position.date_range || "");
    info.append(sym, name);
    const badge = document.createElement("div");
    badge.className =
      "direction-badge direction-" +
      String(position.direction || "").toLowerCase();
    const dirText = position.direction === "Long" ? "Лонг" : "Шорт";
    badge.textContent = dirText;
    badge.setAttribute("role", "status");
    badge.setAttribute("aria-label", `Направление: ${dirText}`);
    header.append(info, badge);
    const details = document.createElement("div");
    details.className = "position-details";

    // аккуратный парсер числа (на случай запятой в CSV)
    const toNum = (x) => {
      if (x == null || x === "") return 0;
      const n = Number(String(x).replace(/\s/g, "").replace(",", "."));
      return Number.isFinite(n) ? n : 0;
    };
    const detailRaw = (label, text) => {
      const item = document.createElement("div");
      item.className = "detail-item";
      const l = document.createElement("div");
      l.className = "detail-label";
      l.textContent = label;
      const v = document.createElement("div");
      v.className = "detail-value";
      v.textContent = String(text ?? "—");
      item.append(l, v);
      return item;
    };
    const detailText = (label, text) => detailRaw(label, String(text ?? "—"));
    const detailCurrency = (label, value) => {
      const n = toNum(value);
      return detailRaw(
        label,
        Number.isFinite(n) ? this.formatCurrency(n) : "—"
      );
    };

    details.append(
      detailText("Плечо", position.leverage), // текстом (может быть "10x")
      detailCurrency("Объем", position.volume_with_leverage), // числом
      detailCurrency("Маржа", position.margin), // числом
      detailCurrency("Комиссия (fee)", position.fee), // числом
      detailCurrency("Фандинг (funding)", position.funding), // числом
      detailText(
        "Время сделки",
        this.formatDuration?.(position.duration) ||
          String(position.duration ?? "—")
      )
    );

    const pnlSection = document.createElement("div");
    pnlSection.className = "pnl-section";
    const left = document.createElement("div");
    left.className = "pnl-left";
    const v = document.createElement("div");
    v.className =
      "pnl-value " + (+position.pnl >= 0 ? "pnl-positive" : "pnl-negative");
    v.textContent = this.formatCurrency(position.pnl);
    left.append(v);

    pnlSection.append(left);
    body.append(header, details, pnlSection);
    card.append(body);
    return card;
  }

  // ===== Hyperliquid Vault Methods =====
  // Документация API: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint

  async fetchVaultData() {
    try {
      // ✅ Параллельные запросы для ускорения загрузки
      const [vaultResponse, positionsResponse] = await Promise.all([
        fetch(CONFIG.HYPERLIQUID_API_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "vaultDetails",
            vaultAddress: CONFIG.VAULT_ADDRESS,
            user: CONFIG.VAULT_ADDRESS,
          }),
        }),
        fetch(CONFIG.HYPERLIQUID_API_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "clearinghouseState",
            user: CONFIG.VAULT_ADDRESS,
          }),
        }),
      ]);

      if (!vaultResponse.ok || !positionsResponse.ok) {
        throw new Error(
          `HTTP error! vault: ${vaultResponse.status}, positions: ${positionsResponse.status}`
        );
      }

      // ✅ Параллельный парсинг JSON
      const [vaultData, positionsData] = await Promise.all([
        vaultResponse.json(),
        positionsResponse.json(),
      ]);

      return {
        vault: vaultData,
        positions: positionsData.assetPositions || [],
        crossMarginSummary: positionsData.crossMarginSummary || {},
      };
    } catch (error) {
      DEBUG.error("Error fetching Hyperliquid vault data:", error);
      return null;
    }
  }

  updateVaultWidget(data) {
    if (!data) return;

    const { vault, positions, crossMarginSummary } = data;

    // ✅ Кэшируем DOM элементы для повторного использования
    if (!this.vaultElements) {
      this.vaultElements = {
        updateTime: document.getElementById("vault-update-time"),
        accountValue: document.getElementById("vault-account-value"),
        apr: document.getElementById("vault-apr"),
        allTimePnl: document.getElementById("vault-all-time-pnl"),
        positionsTitle: document.getElementById("vault-positions-title"),
        positionsList: document.getElementById("vault-positions-list"),
      };
    }

    // Обновляем время последнего обновления
    const now = new Date();
    const timeString = now.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (this.vaultElements.updateTime) {
      this.vaultElements.updateTime.textContent = `Обновлено: ${timeString}`;
    }

    // Извлекаем данные из vault.portfolio согласно документации
    // portfolio - массив: [["day", {...}], ["week", {...}], ["allTime", {...}], ...]
    const portfolioMap = new Map(vault.portfolio || []);
    const allTimeData = portfolioMap.get("allTime") || {};

    // Account Value - последнее значение из accountValueHistory
    let accountValue = 0;
    if (
      allTimeData.accountValueHistory &&
      allTimeData.accountValueHistory.length > 0
    ) {
      const lastEntry =
        allTimeData.accountValueHistory[
          allTimeData.accountValueHistory.length - 1
        ];
      accountValue = parseFloat(lastEntry[1] || "0");
    }

    // Fallback на crossMarginSummary если нет данных в portfolio
    if (accountValue === 0) {
      accountValue = parseFloat(crossMarginSummary?.accountValue || "0");
    }

    // ✅ Используем кэшированные элементы
    if (this.vaultElements.accountValue) {
      this.vaultElements.accountValue.textContent =
        this.formatCurrency(accountValue);
      this.vaultElements.accountValue.className = `vault-stat-value vault-stat-value--large ${
        accountValue >= 0 ? "" : "vault-stat-value--negative"
      }`;
    }

    // APR из vaultDetails (в десятичном формате, умножаем на 100)
    const apr = parseFloat(vault.apr || "0") * 100;
    if (this.vaultElements.apr) {
      this.vaultElements.apr.textContent = `${apr.toFixed(2)}%`;
      this.vaultElements.apr.className = `vault-stat-value vault-stat-value--large vault-stat-value--accent`;
    }

    // All-Time PnL из portfolio.allTime.pnlHistory (последнее значение)
    let displayPnl = 0;
    if (allTimeData.pnlHistory && allTimeData.pnlHistory.length > 0) {
      const lastPnlEntry =
        allTimeData.pnlHistory[allTimeData.pnlHistory.length - 1];
      displayPnl = parseFloat(lastPnlEntry[1] || "0");
    }

    if (this.vaultElements.allTimePnl) {
      this.vaultElements.allTimePnl.textContent =
        this.formatCurrency(displayPnl);
      this.vaultElements.allTimePnl.className = `vault-stat-value vault-stat-value--large ${
        displayPnl >= 0 ? "" : "vault-stat-value--negative"
      }`;
    }

    // Обновляем открытые позиции
    const openPositions = positions.filter(
      (pos) => parseFloat(pos.position?.szi || "0") !== 0
    );

    if (this.vaultElements.positionsTitle) {
      this.vaultElements.positionsTitle.textContent = `Открытые позиции (${openPositions.length})`;
    }

    if (this.vaultElements.positionsList) {
      // ✅ Используем DocumentFragment для пакетного обновления DOM
      const fragment = document.createDocumentFragment();

      if (openPositions.length > 0) {
        openPositions.forEach((pos) => {
          const card = this.renderVaultPosition(pos);
          fragment.appendChild(card);
        });
      } else {
        const emptyMsg = document.createElement("div");
        emptyMsg.className = "vault-position-empty";
        emptyMsg.textContent = "Нет открытых позиций";
        emptyMsg.style.cssText =
          "text-align: center; padding: var(--space-16); color: var(--page-text-secondary);";
        fragment.appendChild(emptyMsg);
      }

      // Одна операция вместо множественных appendChild
      this.vaultElements.positionsList.innerHTML = "";
      this.vaultElements.positionsList.appendChild(fragment);
    }
  }

  renderVaultPosition(position) {
    const card = document.createElement("div");
    card.className = "vault-position-card";

    const coin = position.position?.coin || "UNKNOWN";
    const szi = parseFloat(position.position?.szi || "0");
    const entryPx = parseFloat(position.position?.entryPx || "0");
    const markPx = parseFloat(position.position?.markPx || entryPx);
    const leverage = position.position?.leverage?.value || "1";
    const unrealizedPnl = parseFloat(position.position?.unrealizedPnl || "0");

    // Header: монета и PnL
    const header = document.createElement("div");
    header.className = "vault-position-header";

    const coinEl = document.createElement("div");
    coinEl.className = "vault-position-coin";
    coinEl.textContent = coin;
    coinEl.style.color = this.getCoinColor(coin);

    const pnlEl = document.createElement("div");
    pnlEl.className = `vault-position-pnl ${
      unrealizedPnl >= 0
        ? "vault-position-pnl--positive"
        : "vault-position-pnl--negative"
    }`;
    pnlEl.textContent = this.formatCurrency(unrealizedPnl);

    header.appendChild(coinEl);
    header.appendChild(pnlEl);

    // Details: Size, Entry, Leverage
    const details = document.createElement("div");
    details.className = "vault-position-details";

    const createDetail = (label, value) => {
      const detail = document.createElement("div");
      detail.className = "vault-position-detail";

      const labelEl = document.createElement("div");
      labelEl.className = "vault-position-detail-label";
      labelEl.textContent = label;

      const valueEl = document.createElement("div");
      valueEl.className = "vault-position-detail-value";
      valueEl.textContent = value;

      detail.appendChild(labelEl);
      detail.appendChild(valueEl);
      return detail;
    };

    details.appendChild(createDetail("Size:", Math.abs(szi).toFixed(2)));
    details.appendChild(createDetail("Entry:", `$${entryPx.toFixed(2)}`));
    details.appendChild(createDetail("Leverage:", `${leverage}x`));

    card.appendChild(header);
    card.appendChild(details);

    return card;
  }

  initVaultWidget() {
    // Первоначальная загрузка данных
    this.fetchVaultData().then((data) => {
      if (data) {
        this.updateVaultWidget(data);
      }
    });

    // Кнопка обновления (только ручное обновление)
    const refreshBtn = document.getElementById("vault-refresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", async () => {
        refreshBtn.classList.add("spinning");
        const data = await this.fetchVaultData();
        if (data) {
          this.updateVaultWidget(data);
        }
        setTimeout(() => {
          refreshBtn.classList.remove("spinning");
        }, 1000);
      });
    }

    // ✅ Автообновление отключено - только ручное обновление через кнопку
  }

  // Метод для очистки ресурсов
  destroy() {
    // ✅ Очистка IntersectionObserver
    if (this.positionsObserver) {
      this.positionsObserver.disconnect();
      this.positionsObserver = null;
    }
    // Уничтожение графиков
    if (this.charts) {
      Object.values(this.charts).forEach((chart) => chart?.destroy?.());
      this.charts = {};
    }
  }

  formatCurrency(amount) {
    return this.fmtUSD.format(amount);
  }
}

// Инициализация (единый вход)
document.addEventListener("DOMContentLoaded", () => {
  new TradingDashboard();
  const root = document.documentElement;
  const btn = document.getElementById("theme-toggle");

  // Определяем текущую тему: сохранённая → атрибут → системная
  const getEffectiveTheme = () => {
    const saved = localStorage.getItem("theme"); // 'light' | 'dark' | null
    if (saved === "light" || saved === "dark") return saved;
    if (root.hasAttribute("data-theme")) return root.getAttribute("data-theme");
    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  };

  const applyTheme = (theme) => {
    if (theme === "light" || theme === "dark") {
      root.setAttribute("data-theme", theme);
      localStorage.setItem("theme", theme);
      if (btn) {
        btn.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
        btn.setAttribute(
          "aria-label",
          theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему"
        );
        btn.title =
          theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему";
      }
      document.dispatchEvent(
        new CustomEvent("themechange", { detail: { theme } })
      );
    }
  };
  applyTheme(root.getAttribute("data-theme") || getEffectiveTheme());
  if (btn) {
    btn.addEventListener("click", () => {
      const next = getEffectiveTheme() === "dark" ? "light" : "dark";
      applyTheme(next);
    });
  }

  /* ===== Кнопка «Открыть/Скрыть фильтры» и раскрытие панели ===== */
  (function initMoreFilters() {
    const filtersEl = document.getElementById("filters");
    const toggle = document.getElementById("filters-more-toggle");
    const panel = document.getElementById("more-filters");
    if (!filtersEl || !toggle || !panel) return;
    const OPEN_TEXT = toggle.dataset.openText || "Открыть фильтры";
    const CLOSE_TEXT = toggle.dataset.closeText || "Скрыть фильтры";
    const setState = (isOpen) => {
      toggle.setAttribute("aria-expanded", String(isOpen));
      panel.hidden = !isOpen;
      filtersEl.classList.toggle("filters--open", isOpen);
      const span = toggle.querySelector(".button__text");
      if (span) span.textContent = isOpen ? CLOSE_TEXT : OPEN_TEXT;
      toggle.setAttribute("aria-label", isOpen ? CLOSE_TEXT : OPEN_TEXT);
      if (isOpen) {
        const first = panel.querySelector(
          'select, input, button, [tabindex]:not([tabindex="-1"])'
        );
        if (first)
          try {
            first.focus({ preventScroll: true });
          } catch (_) {}
      }
    };
    toggle.addEventListener("click", () => {
      const exp = toggle.getAttribute("aria-expanded") === "true";
      setState(!exp);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setState(false);
    });
    document.addEventListener(
      "click",
      (e) => {
        if (
          !panel.hidden &&
          !panel.contains(e.target) &&
          !toggle.contains(e.target)
        )
          setState(false);
      },
      { capture: true }
    );
  })();
});
