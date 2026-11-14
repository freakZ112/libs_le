// ==UserScript==
// @name         LE Manager - Darkmode
// @namespace    le-manager
// @version      1.0.20
// @description  Darkmode für Logistics Empire
// @match        https://game.logistics-empire.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://logistics-empire.fans/le-manager/modules/darkmode/latest.meta.js
// @downloadURL  https://logistics-empire.fans/le-manager/modules/darkmode/latest.user.js
// ==/UserScript==

(function () {
    'use strict';

    const MODULE_KEY = 'darkmode';
    const MODULE_VERSION = '1.0.20';
    const SETTING_ENABLED = `modules.${MODULE_KEY}.enabled`;
    const SETTING_PRESET = `modules.${MODULE_KEY}.preset`;
    const ACTION_ACHIEVEMENTS = `modules.${MODULE_KEY}.achievements`;
    const root = window;
    let themeRuntimeStarted = false;

    /* ========================= FLUGSPIEL / ERFOLGE ========================= */

    const FLIGHT_SCORE_KEY = 'darkmode:flight-hits:v1';
    const FLIGHT_SCORE_FALLBACK_KEY = 'lem:darkmode.flight-hits.v1';
    const FLIGHT_UNLOCKS_KEY = 'darkmode:flight-unlocks:v1';
    const FLIGHT_UNLOCKS_FALLBACK_KEY = 'lem:darkmode.flight-unlocks.v1';
    const FLIGHT_ACHIEVEMENTS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];
    const GAME_STYLE_ID = 'lem-darkmode-flight-game-style';
    const GAME_PANEL_CLASS = 'lem-dm-game-panel';
    let gameManager = null;
    let gameSetupDone = false;
    let gameObserver = null;
    let gameLanguage = '';
    let gameScoreKey = '';
    let gameScore = 0;
    let gameSyncPending = false;
    let gameLastSyncAt = 0;
    const GAME_TEXT = {
        title: { de: 'Flugspiel', en: 'Flight game' },
        hits: { de: 'Treffer', en: 'Hits' },
        achievements: { de: 'Erfolge', en: 'Achievements' },
        target: { de: '{n} Treffer', en: '{n} hits' },
        unlocked: { de: 'Freigeschaltet', en: 'Unlocked' },
        locked: { de: 'Noch gesperrt', en: 'Locked' },
        notice: { de: 'Erfolg freigeschaltet!', en: 'Achievement unlocked!' },
        hint: {
            de: 'Klicke auf ein fliegendes Theme-Objekt, um einen Treffer zu sammeln. Jeder Flug zählt höchstens einmal.',
            en: 'Click a flying theme object to collect a hit. Each flight can only be hit once.'
        }
    };

    function gameCoreLanguage() {
        const LEM = gameManager || root.LEM;
        const getSetting = key => {
            try { return LEM?.settings?.get?.(key, null); } catch (_) { return null; }
        };
        const safelyCall = (fn, owner) => {
            try { return typeof fn === 'function' ? fn.call(owner) : null; } catch (_) { return null; }
        };
        const candidates = [
            safelyCall(LEM?.i18n?.getLanguage, LEM?.i18n),
            safelyCall(LEM?.i18n?.getLocale, LEM?.i18n),
            LEM?.i18n?.language, LEM?.i18n?.locale,
            LEM?.ui?.language, LEM?.ui?.locale,
            LEM?.language, LEM?.locale, LEM?.lang,
            getSetting('core.language'), getSetting('ui.language'),
            getSetting('language'), getSetting('locale'),
            document.documentElement.lang, navigator.language
        ];
        for (const candidate of candidates) {
            if (typeof candidate !== 'string') continue;
            const lang = candidate.trim().toLowerCase();
            if (/^de(?:[-_]|$)/.test(lang)) return 'de';
            if (/^en(?:[-_]|$)/.test(lang)) return 'en';
        }
        return 'de';
    }

    function gameText(key, values = {}) {
        const entry = GAME_TEXT[key];
        const base = entry?.[gameCoreLanguage()] || entry?.de || key;
        return Object.entries(values).reduce(
            (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), base
        );
    }

    function flightScoreStorageKey() {
        try {
            return gameManager?.identity?.playerStorageKey?.(FLIGHT_SCORE_KEY) || FLIGHT_SCORE_FALLBACK_KEY;
        } catch (_) {
            return FLIGHT_SCORE_FALLBACK_KEY;
        }
    }

    function storedFlightHits(key) {
        const raw = root.localStorage.getItem(key);
        if (raw === null) return 0;
        const value = Number(raw);
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    }

    function readFlightScore() {
        const key = flightScoreStorageKey();
        try {
            let score = storedFlightHits(key);
            if (key !== FLIGHT_SCORE_FALLBACK_KEY) {
                const fallbackRaw = root.localStorage.getItem(FLIGHT_SCORE_FALLBACK_KEY);
                if (fallbackRaw !== null) {
                    const fallbackScore = storedFlightHits(FLIGHT_SCORE_FALLBACK_KEY);
                    const merged = Math.min(Number.MAX_SAFE_INTEGER, score + fallbackScore);
                    if (fallbackScore > 0) root.localStorage.setItem(key, String(merged));
                    root.localStorage.removeItem(FLIGHT_SCORE_FALLBACK_KEY);
                    score = merged;
                }
            }
            gameScoreKey = key;
            gameScore = score;
        } catch (error) {
            if (key !== gameScoreKey) {
                gameScoreKey = key;
                gameScore = 0;
            }
            console.warn('[LE Manager - Darkmode] Trefferstand konnte nicht gelesen werden:', error);
        }
        return gameScore;
    }

    function flightUnlockStorageKey() {
        try {
            return gameManager?.identity?.playerStorageKey?.(FLIGHT_UNLOCKS_KEY) || FLIGHT_UNLOCKS_FALLBACK_KEY;
        } catch (_) {
            return FLIGHT_UNLOCKS_FALLBACK_KEY;
        }
    }

    function readFlightUnlocks(previousScore) {
        const key = flightUnlockStorageKey();
        try {
            const readSet = storageKey => {
                const raw = root.localStorage.getItem(storageKey);
                if (!raw) return new Set();
                const values = JSON.parse(raw);
                return new Set(Array.isArray(values)
                    ? values.filter(value => FLIGHT_ACHIEVEMENTS.includes(Number(value))).map(Number)
                    : []);
            };
            const unlocked = readSet(key);
            for (const target of FLIGHT_ACHIEVEMENTS) {
                if (previousScore >= target) unlocked.add(target);
            }
            if (key !== FLIGHT_UNLOCKS_FALLBACK_KEY) {
                for (const target of readSet(FLIGHT_UNLOCKS_FALLBACK_KEY)) unlocked.add(target);
            }
            return { key, unlocked };
        } catch (error) {
            console.warn('[LE Manager - Darkmode] Achievement-Status konnte nicht gelesen werden:', error);
            return null;
        }
    }

    function saveFlightUnlocks(state) {
        if (!state) return;
        try {
            root.localStorage.setItem(state.key, JSON.stringify([...state.unlocked].sort((a, b) => a - b)));
            if (state.key !== FLIGHT_UNLOCKS_FALLBACK_KEY) {
                root.localStorage.removeItem(FLIGHT_UNLOCKS_FALLBACK_KEY);
            }
        } catch (error) {
            console.warn('[LE Manager - Darkmode] Achievement-Status konnte nicht gespeichert werden:', error);
        }
    }

    function historicalFlightScore() {
        let highest = 0;
        try {
            for (let i = 0; i < root.localStorage.length; i++) {
                const key = root.localStorage.key(i);
                if (key && key !== FLIGHT_SCORE_FALLBACK_KEY && key.includes(FLIGHT_SCORE_KEY)) {
                    highest = Math.max(highest, storedFlightHits(key));
                }
            }
        } catch (_) {}
        return highest;
    }

    function achievementColor(index) {
        return `hsl(${Math.round(index * 330 / (FLIGHT_ACHIEVEMENTS.length - 1))} 85% 52%)`;
    }

    function injectFlightGameStyles() {
        if (document.getElementById(GAME_STYLE_ID) || !document.head) return;
        const style = document.createElement('style');
        style.id = GAME_STYLE_ID;
        style.textContent = `
            .${GAME_PANEL_CLASS} {
                width:100%; min-width:0; box-sizing:border-box; margin:10px 0;
                padding:12px; border-radius:10px; border:1px solid rgba(128,145,165,.3);
                color:var(--lem-text,inherit); background:rgba(110,127,150,.08);
                font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
            }
            .lem-dm-game-top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
            .lem-dm-game-title { font-size:13px; font-weight:750; }
            .lem-dm-game-score { font-size:13px; font-weight:850; font-variant-numeric:tabular-nums; }
            .lem-dm-game-hint { font-size:11px; opacity:.75; line-height:1.35; margin:6px 0 10px; }
            .lem-dm-game-achievements { display:grid; grid-template-columns:repeat(auto-fit,minmax(46px,1fr)); gap:7px; }
            .lem-dm-game-tile {
                aspect-ratio:1; border-radius:8px; display:flex; align-items:center; justify-content:center;
                color:#fff; font-size:18px; font-weight:900; font-variant-numeric:tabular-nums;
                background:var(--achievement-color); border:1px solid rgba(255,255,255,.18);
                box-sizing:border-box; position:relative; transition:filter .2s,opacity .2s,transform .2s;
                text-shadow:0 1px 3px rgba(0,0,0,.65);
            }
            .lem-dm-game-tile[data-unlocked="false"] { opacity:.42; filter:saturate(.62); }
            .lem-dm-game-tile[data-unlocked="true"] {
                opacity:1; box-shadow:0 0 0 1px rgba(255,255,255,.22) inset,0 3px 10px rgba(0,0,0,.16);
            }
            .lem-dm-game-tile[data-unlocked="true"]::after {
                content:'✓'; position:absolute; top:1px; right:3px; font-size:9px;
            }
            /* Die Core-Aktionszeile bleibt als Anker im DOM, nur der Knopf verschwindet. */
            .lem-dm-game-hidden-action {
                position:absolute !important; width:1px !important; height:1px !important;
                margin:0 !important; padding:0 !important; border:0 !important;
                opacity:0 !important; visibility:hidden !important;
                overflow:hidden !important; pointer-events:none !important;
            }
            .lem-dm-game-notice {
                position:fixed; z-index:2147483646; top:68px; right:16px;
                max-width:min(340px,calc(100vw - 32px)); box-sizing:border-box;
                border-radius:12px; padding:11px 15px;
                background:linear-gradient(120deg,var(--achievement-color),#222838);
                color:#fff; font:700 13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
                box-shadow:0 10px 35px rgba(0,0,0,.4);
                animation:lem-dm-game-pop .3s ease-out;
            }
            .lem-dm-game-notice strong { display:block; font-size:14px; }
            .lem-dm-game-plus {
                position:fixed; z-index:2147483647; pointer-events:none; color:#fff;
                text-shadow:0 2px 5px #000; font:bold 24px system-ui,sans-serif;
                animation:lem-dm-game-hit .7s ease-out forwards;
            }
            @keyframes lem-dm-game-pop { from { opacity:0; transform:translateY(-8px) scale(.96) } to { opacity:1; transform:none } }
            @keyframes lem-dm-game-hit { from { opacity:1; transform:translateY(0) } to { opacity:0; transform:translateY(-42px) } }
        `;
        document.head.appendChild(style);
    }

    function createFlightGamePanel() {
        const panel = document.createElement('div');
        panel.className = GAME_PANEL_CLASS;
        panel.dataset.lemDarkmodeGame = 'true';
        panel.innerHTML = `
            <div class="lem-dm-game-top">
                <span class="lem-dm-game-title"></span>
                <span class="lem-dm-game-score"></span>
            </div>
            <div class="lem-dm-game-hint"></div>
            <div class="lem-dm-game-achievements"></div>
        `;
        const grid = panel.querySelector('.lem-dm-game-achievements');
        FLIGHT_ACHIEVEMENTS.forEach((target, index) => {
            const tile = document.createElement('div');
            tile.className = 'lem-dm-game-tile';
            tile.dataset.target = String(target);
            tile.style.setProperty('--achievement-color', achievementColor(index));
            tile.textContent = target.toLocaleString('de-DE');
            grid.appendChild(tile);
        });
        refreshFlightGamePanel(panel);
        return panel;
    }

    function refreshFlightGamePanel(panel) {
        if (!panel) return;
        const score = readFlightScore();
        const lang = gameCoreLanguage();
        const title = panel.querySelector('.lem-dm-game-title');
        const value = panel.querySelector('.lem-dm-game-score');
        const hint = panel.querySelector('.lem-dm-game-hint');
        const titleText = `${gameText('title')} · ${gameText('achievements')}`;
        const valueText = `${gameText('hits')}: ${score.toLocaleString(lang === 'de' ? 'de-DE' : 'en-US')}`;
        if (title && title.textContent !== titleText) title.textContent = titleText;
        if (value && value.textContent !== valueText) value.textContent = valueText;
        if (hint && hint.textContent !== gameText('hint')) hint.textContent = gameText('hint');
        for (const tile of panel.querySelectorAll('.lem-dm-game-tile')) {
            const target = Number(tile.dataset.target);
            const unlocked = score >= target;
            const flag = String(unlocked);
            const tooltip = `${gameText('target', { n: target.toLocaleString(lang === 'de' ? 'de-DE' : 'en-US') })} · ${gameText(unlocked ? 'unlocked' : 'locked')}`;
            if (tile.dataset.unlocked !== flag) tile.dataset.unlocked = flag;
            if (tile.title !== tooltip) tile.title = tooltip;
            const label = target.toLocaleString(lang === 'de' ? 'de-DE' : 'en-US');
            if (tile.textContent !== label) tile.textContent = label;
        }
    }

    function refreshFlightGamePanels() {
        document.querySelectorAll(`.${GAME_PANEL_CLASS}`).forEach(refreshFlightGamePanel);
    }

    function mountFlightGameInCoreSettings() {
        if (!document.body) return;
        injectFlightGameStyles();
        const actionNames = ['Auszeichnungen', 'Achievements'];
        const labelNames = ['Flugspiel – Treffer und Erfolge', 'Flight game – hits and achievements'];
        const presetNames = ['Farbschema (Seite wird neu geladen)', 'Color preset (reloads the page)'];
        const buttons = Array.from(document.querySelectorAll('button')).filter(button =>
            actionNames.some(name => button.textContent?.includes(name)) &&
            !button.closest(`.${GAME_PANEL_CLASS}`)
        );
        const rows = [];
        for (const button of buttons) {
            if (button.style.display === 'none') button.style.removeProperty('display');
            button.classList.add('lem-dm-game-hidden-action');
            let row = null;
            for (let candidate = button.parentElement, depth = 0;
                candidate && depth < 7; candidate = candidate.parentElement, depth++) {
                if (labelNames.some(name => (candidate.textContent || '').includes(name)) &&
                    candidate.querySelectorAll('button').length <= 2) {
                    row = candidate;
                    break;
                }
            }
            row ||= button.parentElement?.parentElement || button.parentElement;
            if (row?.parentElement) rows.push(row);
        }
        if (!rows.length) {
            const labels = [...labelNames, ...presetNames];
            const candidates = Array.from(document.querySelectorAll('label, span, p, strong, div'));
            const match = candidates.find(node =>
                !node.closest(`.${GAME_PANEL_CLASS}`) &&
                labels.includes((node.textContent || '').trim()) &&
                !Array.from(node.children).some(child => labels.includes((child.textContent || '').trim()))
            );
            if (match) {
                let row = match.parentElement;
                for (let depth = 0; row && depth < 5; row = row.parentElement, depth++) {
                    if (row.querySelector('select, [role="combobox"], button')) break;
                }
                row ||= match.parentElement?.parentElement || match.parentElement;
                if (row?.parentElement) rows.push(row);
            }
        }
        for (const row of [...new Set(rows)]) {
            const next = row.nextElementSibling;
            if (next?.classList.contains(GAME_PANEL_CLASS)) {
                refreshFlightGamePanel(next);
                continue;
            }
            const existing = Array.from(row.parentElement.children).find(child =>
                child.classList?.contains(GAME_PANEL_CLASS)
            );
            if (existing) {
                row.insertAdjacentElement('afterend', existing);
                refreshFlightGamePanel(existing);
            } else {
                row.insertAdjacentElement('afterend', createFlightGamePanel());
            }
        }
    }

    function scheduleFlightGameSync() {
        if (gameSyncPending) return;
        gameSyncPending = true;
        const delay = Math.max(0, 300 - (Date.now() - gameLastSyncAt));
        setTimeout(() => {
            gameSyncPending = false;
            gameLastSyncAt = Date.now();
            mountFlightGameInCoreSettings();
            refreshFlightGamePanels();
        }, delay);
    }

    function showFlightAchievement(target) {
        if (!document.body) return;
        injectFlightGameStyles();
        const index = FLIGHT_ACHIEVEMENTS.indexOf(target);
        const notice = document.createElement('div');
        notice.className = 'lem-dm-game-notice';
        notice.style.setProperty('--achievement-color', achievementColor(index));
        notice.setAttribute('role', 'status');
        const headline = document.createElement('strong');
        headline.textContent = `🏆 ${gameText('notice')}`;
        notice.appendChild(headline);
        notice.appendChild(document.createTextNode(gameText('target', { n: target.toLocaleString(gameCoreLanguage() === 'de' ? 'de-DE' : 'en-US') })));
        document.body.appendChild(notice);
        setTimeout(() => notice.remove(), 4300);
    }

    function showFlightHitEffect(x, y) {
        if (!document.body || !Number.isFinite(x) || !Number.isFinite(y)) return;
        const effect = document.createElement('span');
        effect.className = 'lem-dm-game-plus';
        effect.textContent = '+1';
        effect.style.left = `${x}px`;
        effect.style.top = `${y}px`;
        document.body.appendChild(effect);
        setTimeout(() => effect.remove(), 800);
    }

    function collectFlightHit(x, y) {
        const previous = readFlightScore();
        if (previous >= Number.MAX_SAFE_INTEGER) return;
        const scoreKey = gameScoreKey;
        const isTemporaryScore = scoreKey === FLIGHT_SCORE_FALLBACK_KEY &&
            typeof gameManager?.identity?.playerStorageKey === 'function';
        const priorAchievementScore = isTemporaryScore
            ? Math.max(previous, historicalFlightScore())
            : previous;
        const achievementState = readFlightUnlocks(priorAchievementScore);
        const nextScore = previous + 1;
        try {
            root.localStorage.setItem(scoreKey, String(nextScore));
        } catch (error) {
            console.warn('[LE Manager - Darkmode] Trefferstand konnte nicht gespeichert werden:', error);
        }
        const current = readFlightScore();
        showFlightHitEffect(x, y);
        refreshFlightGamePanels();
        scheduleFlightGameSync();
        if (!achievementState || current <= previous) return;
        for (const target of FLIGHT_ACHIEVEMENTS) {
            if (current < target) continue;
            const newlyReached = previous < target && !achievementState.unlocked.has(target);
            achievementState.unlocked.add(target);
            if (newlyReached) showFlightAchievement(target);
        }
        saveFlightUnlocks(achievementState);
    }

    function setupFlightGame(LEM) {
        gameManager = LEM;
        if (gameSetupDone) return;
        gameSetupDone = true;
        gameScoreKey = '';
        readFlightScore();
        const start = () => {
            injectFlightGameStyles();
            scheduleFlightGameSync();
            if (!gameObserver) {
                gameObserver = new MutationObserver(scheduleFlightGameSync);
                gameObserver.observe(document.body, { childList:true, subtree:true });
            }
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once:true });
        } else {
            start();
        }
        root.addEventListener('LEM:setting-changed', scheduleFlightGameSync);
        root.addEventListener('storage', event => {
            if (![flightScoreStorageKey(), FLIGHT_SCORE_FALLBACK_KEY].includes(event.key)) return;
            refreshFlightGamePanels();
            scheduleFlightGameSync();
        });
        setInterval(() => {
            const lang = gameCoreLanguage();
            if (lang !== gameLanguage || gameScoreKey !== flightScoreStorageKey()) {
                gameLanguage = lang;
            }

            refreshFlightGamePanels();
            scheduleFlightGameSync();
        }, 1500);
    }

    function cleanParticleImage(value) {
        const url = cleanImage(value);
        if (url) return url;
        if (typeof value !== 'string' || value.length > 360000) return null;
        const prefix = 'data:image/svg+xml;charset=utf-8,';
        let svg;
        try {
            svg = (value.startsWith(prefix)
                   ? decodeURIComponent(value.slice(prefix.length)) : value).trim();
        } catch (_) {
            return null;
        }
        if (svg.length > 120000) return null;
        if (!/^<svg(?:\s|>)/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) return null;
        if (/<(?:script|style|foreignobject|iframe|image|audio|video|animate|set|use)\b/i.test(svg)) return null;
        if (/<!(?:doctype|entity)|<\?|\bon[a-z]+\s*=|\b(?:href|xlink:href)\s*=|(?:javascript:|data:)/i.test(svg)) return null;
        if (/url\(\s*['"]?(?!#)/i.test(svg)) return null;
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }

    /* ========================= Partikel Setup ========================= */

    function sanitizeParticles(raw) {
        if (!isObject(raw)) return null;
        const count = cleanNumber(raw.count, 1, 300);
        if (count === null) return null;

        const render = raw.render === 'sprite' ? 'sprite' : 'circle';
        const image = render === 'sprite' ? cleanParticleImage(raw.image) : null;
        if (render === 'sprite' && !image) return null;

        const circle = render === 'circle';

        const pair = (minKey, maxKey, low, high, defaultMin, defaultMax) => {
            const min = cleanNumber(raw[minKey], low, high) ?? defaultMin;
            const max = cleanNumber(raw[maxKey], low, high) ?? defaultMax;
            return min <= max ? [min, max] : [max, min];
        };

        const [sizeMin, sizeMax] = pair(
            'sizeMin', 'sizeMax', 0.5, 200,
            circle ? 1.2 : 10,
            circle ? 3.6 : 24
        );

        const [speedMin, speedMax] = pair(
            'speedMin', 'speedMax', 1, 300, 22, 60
        );

        const [swayAmplitudeMin, swayAmplitudeMax] = pair(
            'swayAmplitudeMin', 'swayAmplitudeMax', 0, 200, 7.2, 18
        );

        const [swayFrequencyMin, swayFrequencyMax] = pair(
            'swayFrequencyMin', 'swayFrequencyMax', 0, 3,
            0.5 / (2 * Math.PI),
            1.4 / (2 * Math.PI)
        );

        const [rotationSpeedMin, rotationSpeedMax] = pair(
            'rotationSpeedMin', 'rotationSpeedMax', -360, 360, 0, 0
        );

        return {
            type: raw.type === 'leaves' ? 'leaves' : 'snow',
            render,
            ...(image ? { image } : {}),
            frames: Math.round(cleanNumber(raw.frames, 1, 24) ?? 1),
            count: Math.round(count),
            sizeMin,
            sizeMax,
            speedMin,
            speedMax,
            wind: cleanNumber(raw.wind, -100, 100) ?? 0,
            swayAmplitudeMin,
            swayAmplitudeMax,
            swayFrequencyMin,
            swayFrequencyMax,
            rotationSpeedMin,
            rotationSpeedMax,
            opacity: cleanNumber(raw.opacity, 0, 1) ?? 0.85,
            // Maximale Bildrate der Animation (spart Rechenleistung, 30 reicht für langsame Motive).
            fps: Math.round(cleanNumber(raw.fps, 10, 60) ?? 30),
            color: typeof raw.color === 'string' && COLOR_RE.test(raw.color)
            ? raw.color : '#ffffff',
            zIndex: Math.round(cleanNumber(raw.zIndex, 0, 1000) ?? 40)
        };
    }

    /* ========================= FARB-PRESETS ========================= */

    const BASE_COLORS = {
        surface: '#2F2E34',
        surfaceRaised: '#35343B',
        surfaceHover: '#424047',
        header: '#2F2E34',
        hudBar: '#2F2E34',
        hudBarBorder: '#5c5a63',
        navTop: '#2F2E34',
        navMid: '#2F2E34',
        navBottom: '#262222',
        navBorder: '#404040',
        navButtonTop: '#2F2E34',
        navButtonBottom: '#262222',
        navActiveTop: '#404040',
        navActiveBottom: '#2F2E34',
        button: '#35343B',
        buttonActive: '#4A4343',
        buttonDisabled: '#918C8C',
        buttonEnabled: '#3f7253',
        buttonEnabledBorder: '#918C8C',
        buttonEnabledHover: '#4a825f',
        addButton: '#456b55',
        addButtonHover: '#527b61',
        addButtonBorder: '#404040',
        allianceBlueTop: '#2F2E34',
        allianceBlueBottom: '#2F2E34',
        allianceBlueBorder: '#4A4343',
        alert: '#4f3036',
        buildingAlert: '#7e323d',
        buildingAlertBorder: '#d65360',
        info: '#35343B',
        input: '#404040',
        border: '#4A4343',
        borderStrong: '#404040',
        text: '#C7C7C7',
        muted: '#C7C7C7',
        backdrop: '#18191d',
        textStrong: '#f3f3f5',
        textSub: '#c9c5ca',
        lineLight: '#706e77',
        lineDark: '#222126',
        navActiveBorder: '#94606d',
        navActiveGlow: 'rgba(180,90,110,0.15)',
        buttonActiveBorder: '#806169',
        buttonActiveGlow: 'rgba(180,110,125,0.14)',
        buttonDisabledBorder: '#535158',
        buttonDisabledText: '#99999f',
        buttonEnabledHoverBorder: '#7fb18d',
        addButtonHoverBorder: '#83a68c',
        selectedTop: '#245786',
        selectedBottom: '#123a5e'
    };

    const BASE_MAP = {
        colorAlpha: 0.34,
        colorFilter: 'saturate(100%) sepia(0%) hue-rotate(0deg)',
        tint: 'rgba(130,67,65,0.18)',
        roadWarmth: 0.22,
        roadFilter: 'sepia(100%) saturate(180%) hue-rotate(318deg) brightness(94%) contrast(106%)',
        buildingBrightness: 0.85
    };

    const DEFAULT_PRESET = 'grau';
    const BUILTIN_PRESETS = {
        grau: {
            label: { de: 'Grau', en: 'Grey' },
            colors: {},
            map: {}
        }
    };

    const PRESET_BASE_URL = 'https://raw.githubusercontent.com/freakZ112/libs_le/refs/heads/main/le-darkmode-presets/';
    const PRESET_IMAGE_URL_PREFIX = 'https://raw.githubusercontent.com/freakZ112/libs_le/';
    const PRESET_CACHE_KEY = 'le-darkmode-presets-v1';
    const PRESET_CACHE_MAX_AGE = 30 * 60 * 1000;
    const PRESET_FETCH_TIMEOUT = 4000;

    const presetFetch = root.fetch.bind(root);

    /* ========================= PRESET-VALIDIERUNG ========================= */

    const COLOR_KEYS = new Set([...Object.keys(BASE_COLORS), 'navGlowHover']);
    const COLOR_RE = /^(?:#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*\d*\.?\d+\s*)?\))$/i;
    const FILTER_FN = '(?:saturate|sepia|hue-rotate|brightness|contrast|grayscale|invert|opacity|blur)\\(\\s*-?\\d*\\.?\\d+(?:%|deg|px)?\\s*\\)';
    const SHADOW_FN = 'drop-shadow\\(\\s*-?\\d*\\.?\\d+(?:px)?\\s+-?\\d*\\.?\\d+(?:px)?\\s+\\d*\\.?\\d+(?:px)?\\s+(?:#[0-9a-f]{3,8}|rgba?\\([\\d.\\s,]+\\))\\s*\\)';
    const FILTER_RE = new RegExp(`^(?:\\s*(?:${FILTER_FN}|${SHADOW_FN}))+\\s*$`, 'i');
    const IMAGE_DATA_RE = /^data:image\/(?:webp|png|jpeg|gif|avif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;
    const IMAGE_URL_RE = /^https:\/\/raw\.githubusercontent\.com\/freakZ112\/libs_le\/[A-Za-z0-9_.\/%-]+$/;
    const CSS_TOKEN_RE = /^[a-z0-9.%\s-]{1,40}$/i;
    const ID_RE = /^[a-z0-9_-]{1,32}$/;

    const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

    function cleanNumber(value, min, max) {
        return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
            ? value : null;
    }

    function cleanImage(value) {
        if (typeof value !== 'string' || value.length > 700000) return null;
        if (IMAGE_DATA_RE.test(value)) return value;
        if (value.startsWith(PRESET_IMAGE_URL_PREFIX) && IMAGE_URL_RE.test(value)) return value;
        return null;
    }

    function cleanText(value, fallback) {
        if (typeof value !== 'string') return fallback;
        const text = value.replace(/[\u0000-\u001f<>"'`\\]/g, '').trim().slice(0, 40);
        return text || fallback;
    }

    function sanitizeIndex(list) {
        if (!Array.isArray(list)) return null;
        const result = [];
        for (const entry of list.slice(0, 50)) {
            if (!isObject(entry) || !ID_RE.test(entry.id ?? '') || entry.id in BUILTIN_PRESETS) continue;
            const file = typeof entry.file === 'string' && /^[a-z0-9_-]{1,32}\.json$/.test(entry.file)
            ? entry.file : `${entry.id}.json`;
            const label = isObject(entry.label) ? entry.label : {};
            result.push({
                id: entry.id,
                file,
                label: { de: cleanText(label.de, entry.id), en: cleanText(label.en, entry.id) }
            });
        }
        return result;
    }

    function sanitizePreset(raw) {
        if (!isObject(raw) || raw.schema !== 1) return null;
        if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || raw.id in BUILTIN_PRESETS) return null;

        const label = isObject(raw.label) ? raw.label : {};
        const out = {
            schema: 1,
            id: raw.id,
            label: { de: cleanText(label.de, raw.id), en: cleanText(label.en, raw.id) },
            colors: {},
            map: {}
        };

        if (isObject(raw.colors)) {
            for (const [key, value] of Object.entries(raw.colors)) {
                if (COLOR_KEYS.has(key) && typeof value === 'string' && COLOR_RE.test(value)) {
                    out.colors[key] = value;
                }
            }
        }

        if (isObject(raw.map)) {
            for (const key of ['colorAlpha', 'roadWarmth']) {
                const value = cleanNumber(raw.map[key], 0, 1);
                if (value !== null) out.map[key] = value;
            }
            const brightness = cleanNumber(raw.map.buildingBrightness, 0, 2);
            if (brightness !== null) out.map.buildingBrightness = brightness;
            for (const key of ['colorFilter', 'roadFilter']) {
                const value = raw.map[key];
                if (typeof value === 'string' && value.length <= 300 && FILTER_RE.test(value)) {
                    out.map[key] = value;
                }
            }
            if (typeof raw.map.tint === 'string' && COLOR_RE.test(raw.map.tint)) {
                out.map.tint = raw.map.tint;
            }
            if (isObject(raw.map.vector)) {
                const vector = {};
                const ranges = { hue: [0, 360], saturation: [0, 1], keepColor: [0, 1], brightness: [0.3, 2] };
                for (const [key, [min, max]] of Object.entries(ranges)) {
                    const value = cleanNumber(raw.map.vector[key], min, max);
                    if (value !== null) vector[key] = value;
                }
                if (Object.keys(vector).length) out.map.vector = vector;
            }
        }

        if (isObject(raw.hud) && isObject(raw.hud.assets)) {
            const assets = {};
            for (const key of ['left', 'right', 'ground']) {
                const item = raw.hud.assets[key];
                if (!isObject(item)) continue;
                const w = cleanNumber(item.w, 1, 4000);
                const h = cleanNumber(item.h, 1, 4000);
                const url = cleanImage(item.url);
                if (w && h && url) assets[key] = { w, h, url };
            }
            if (assets.left && assets.right) {
                out.hud = {
                    assets,
                    scale: cleanNumber(raw.hud.scale, 0.1, 4) ?? 1,
                    bottom: cleanNumber(raw.hud.bottom, -500, 500) ?? 0,
                    hideBar: raw.hud.hideBar === true,
                    groundTile: raw.hud.groundTile === true
                };
            }
        }

        if (isObject(raw.icons)) {
            const icons = {};
            for (const [key, value] of Object.entries(raw.icons).slice(0, 20)) {
                const url = cleanImage(value);
                if (/^[\w\/-]{1,60}$/.test(key) && url) icons[key] = url;
            }
            if (Object.keys(icons).length) out.icons = icons;
        }

        if (isObject(raw.navDecor)) {
            const image = cleanImage(raw.navDecor.image);
            const token = (value, fallback) =>
            typeof value === 'string' && CSS_TOKEN_RE.test(value) ? value : fallback;
            if (image) {
                out.navDecor = {
                    image,
                    size: token(raw.navDecor.size, 'auto 100%'),
                    positionLeft: token(raw.navDecor.positionLeft, '0 0'),
                    positionRight: token(raw.navDecor.positionRight, '0 0')
                };
            }
        }

        if (isObject(raw.corners)) {
            const image = cleanImage(raw.corners.image);
            if (image) {
                const filter = raw.corners.filter;
                out.corners = {
                    image,
                    size: cleanNumber(raw.corners.size, 20, 800) ?? 200,
                    zIndex: Math.round(cleanNumber(raw.corners.zIndex, 0, 1000) ?? 0),
                    opacity: cleanNumber(raw.corners.opacity, 0, 1) ?? 1,
                    filter: typeof filter === 'string' && filter.length <= 300 && FILTER_RE.test(filter)
                    ? filter : ''
                };
            }
        }

        const hudHeader = cleanImage(raw.hudHeader);
        if (hudHeader) out.hudHeader = hudHeader;

        const addButton = cleanImage(raw.addButton);
        if (addButton) out.addButton = addButton;

        if (isObject(raw.snow)) {
            const snow = raw.snow;
            const count = cleanNumber(snow.count, 1, 300);
            if (count) {
                let sizeMin = cleanNumber(snow.sizeMin, 0.5, 12) ?? 1.2;
                let sizeMax = cleanNumber(snow.sizeMax, 0.5, 12) ?? 3.6;
                let speedMin = cleanNumber(snow.speedMin, 5, 300) ?? 22;
                let speedMax = cleanNumber(snow.speedMax, 5, 300) ?? 60;
                if (sizeMin > sizeMax) [sizeMin, sizeMax] = [sizeMax, sizeMin];
                if (speedMin > speedMax) [speedMin, speedMax] = [speedMax, speedMin];

                out.snow = {
                    count: Math.round(count),
                    sizeMin,
                    sizeMax,
                    speedMin,
                    speedMax,
                    drift: cleanNumber(snow.drift, 0, 100) ?? 18,
                    opacity: cleanNumber(snow.opacity, 0, 1) ?? 0.85,
                    color: typeof snow.color === 'string' && COLOR_RE.test(snow.color)
                    ? snow.color : '#ffffff',
                    zIndex: Math.round(cleanNumber(snow.zIndex, 0, 1000) ?? 40)
                };
            }
        }

        out.particles = sanitizeParticles(raw.particles);

        if (!out.particles && out.snow) {
            const snow = out.snow;

            out.particles = sanitizeParticles({
                ...snow,
                type: 'snow',
                render: 'circle',
                wind: 0,
                swayAmplitudeMin: snow.drift * 0.4,
                swayAmplitudeMax: snow.drift,
                swayFrequencyMin: 0.5 / (2 * Math.PI),
                swayFrequencyMax: 1.4 / (2 * Math.PI)
            });
        }

        if (isObject(raw.flight)) {
            const image = cleanImage(raw.flight.image);
            if (image) {
                const direction = ['ltr', 'rtl', 'alternate'].includes(raw.flight.direction)
                ? raw.flight.direction : 'alternate';
                out.flight = {
                    image,
                    widthFactor: cleanNumber(raw.flight.widthFactor, 0.01, 0.8) ?? 0.1,
                    minWidth: cleanNumber(raw.flight.minWidth, 20, 2000) ?? 160,
                    maxWidth: cleanNumber(raw.flight.maxWidth, 20, 3000) ?? 600,
                    speed: cleanNumber(raw.flight.speed, 20, 2000) ?? 240,
                    minDuration: cleanNumber(raw.flight.minDuration, 500, 120000) ?? 6000,
                    swing: cleanNumber(raw.flight.swing, 0, 0.4) ?? 0.06,
                    waves: cleanNumber(raw.flight.waves, 0, 6) ?? 1.5,
                    intervalMs: Math.round(cleanNumber(raw.flight.intervalMs, 15000, 3600000) ?? 120000),
                    direction
                };
                if (out.flight.minWidth > out.flight.maxWidth) {
                    [out.flight.minWidth, out.flight.maxWidth] =
                        [out.flight.maxWidth, out.flight.minWidth];
                }
            }
        }

        return out;
    }

    /* ========================= PRESET-SPEICHER ========================= */

    function loadPresetCache() {
        const empty = { savedAt: 0, index: null, presets: {} };
        try {
            const parsed = JSON.parse(root.localStorage.getItem(PRESET_CACHE_KEY) || 'null');
            if (!isObject(parsed) || parsed.v !== 1) return empty;

            const presets = {};
            for (const [id, entry] of Object.entries(
                isObject(parsed.presets) ? parsed.presets : {}
            )) {
                const clean = sanitizePreset(entry?.data);
                if (clean && clean.id === id) presets[id] = { data: clean };
            }

            return {
                savedAt: Number(parsed.savedAt) || 0,
                index: sanitizeIndex(parsed.index),
                presets
            };
        } catch (_) {
            return empty;
        }
    }

    function savePresetCache() {
        try {
            root.localStorage.setItem(PRESET_CACHE_KEY, JSON.stringify({
                v: 1,
                savedAt: presetCache.savedAt,
                index: presetCache.index,
                presets: presetCache.presets
            }));
        } catch (error) {
            console.warn('[LE Manager - Darkmode] Presets konnten nicht gespeichert werden:', error);
        }
    }

    const presetCache = loadPresetCache();

    async function fetchPresetJson(name) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PRESET_FETCH_TIMEOUT);
        try {
            const response = await presetFetch(PRESET_BASE_URL + name, {
                cache: 'no-cache',
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`HTTP ${response.status} bei ${name}`);
            return await response.json();
        } finally {
            clearTimeout(timer);
        }
    }

    async function loadPreset(id) {
        if (!ID_RE.test(id) || id in BUILTIN_PRESETS) {
            throw new Error(`Ungültige Preset-ID: ${id}`);
        }
        const entry = presetCache.index?.find(item => item.id === id);
        const clean = sanitizePreset(await fetchPresetJson(entry?.file || `${id}.json`));
        if (!clean || clean.id !== id) throw new Error(`Preset ${id} ist ungültig`);

        presetCache.presets[id] = { data: clean };
        savePresetCache();
        return clean;
    }

    async function refreshIndex() {
        const raw = await fetchPresetJson('index.json');
        const list = sanitizeIndex(raw?.presets);

        if (!list?.length) {
            throw new Error('index.json ist leer oder ungültig');
        }

        presetCache.index = list;
        presetCache.savedAt = Date.now();

        savePresetCache();
        syncPresetOptions();
    }

    let indexRefreshPromise = null;
    let indexLastAttempt = 0;

    async function ensureIndexFresh() {
        if (
            presetCache.index?.length &&
            Date.now() - presetCache.savedAt < PRESET_CACHE_MAX_AGE
        ) {
            return false;
        }
        if (indexRefreshPromise) {
            return indexRefreshPromise;
        }
        if (Date.now() - indexLastAttempt < 30000) {
            return false;
        }
        indexLastAttempt = Date.now();
        indexRefreshPromise = (async () => {
            try {
                await refreshIndex();
                return true;
            } catch (error) {
                console.info(
                    '[LE Manager - Darkmode] Index nicht aktualisiert (Cache bleibt erhalten):',
                    error?.message ?? error
                );
                return false;
            }
        })().finally(() => {
            indexRefreshPromise = null;
        });

        return indexRefreshPromise;
    }

    async function refreshPresetsInBackground(id) {
        const updated = await ensureIndexFresh();

        if (!updated || !id || id in BUILTIN_PRESETS) {
            return;
        }

        try {
            const before = JSON.stringify(
                presetCache.presets[id]?.data
            );

            const fresh = await loadPreset(id);

            if (JSON.stringify(fresh) !== before) {
                console.info(
                    `[LE Manager - Darkmode] Preset "${id}" aktualisiert - gilt ab dem nächsten Neuladen.`
                );
            }
        } catch (error) {
            console.info(
                '[LE Manager - Darkmode] Aktives Preset nicht aktualisiert (Cache bleibt erhalten):',
                error?.message ?? error
            );
        }
    }

    function getPreset(id) {
        return BUILTIN_PRESETS[id] ||
            presetCache.presets[id]?.data ||
            null;
    }

    function presetOptions() {
        const list = presetCache.index || [];
        return [
            { value: DEFAULT_PRESET, label: BUILTIN_PRESETS[DEFAULT_PRESET].label },
            ...list.map(item => ({ value: item.id, label: item.label }))
        ];
    }
    let moduleRegistered = false;

    function syncPresetOptions() {
        const options = presetOptions();

        const select = definition.settings.items.find(
            item => item.key === SETTING_PRESET
        );
        if (
            JSON.stringify(select?.options) ===
            JSON.stringify(options)
        ) {
            return;
        }
        definition.settings = {
            ...definition.settings,
            items: definition.settings.items.map(item =>
                                                 item.key === SETTING_PRESET
                                                 ? { ...item, options }
                                                 : item
                                                )
        };
        if (
            !moduleRegistered ||
            !root.LEM?.modules?.registerManaged
        ) {
            return;
        }
        try {
            root.LEM.modules.registerManaged({
                ...definition
            });
        } catch (error) {
            console.warn(
                '[LE Manager - Darkmode] Theme-Auswahl konnte nicht aktualisiert werden:',
                error
            );
        }
    }

    /* ========================= FARB-HELFER (Karte) ========================= */

    // Einfärbung der Vektor-Karte (OpenMapTiles): Farbton, Sättigung, Anteil der Original-Farben, Helligkeit
    const BASE_VECTOR = { hue: 0, saturation: 0, keepColor: 0.18, brightness: 1 };

    function parseCssColor(value) {
        if (typeof value !== 'string') return null;
        const text = value.trim().toLowerCase();
        let match;

        if ((match = /^#([0-9a-f]{3,8})$/.exec(text))) {
            let hex = match[1];
            if (hex.length === 3 || hex.length === 4) hex = [...hex].map((char) => char + char).join('');
            if (hex.length === 6) hex += 'ff';
            if (hex.length !== 8) return null;
            return {
                r: parseInt(hex.slice(0, 2), 16),
                g: parseInt(hex.slice(2, 4), 16),
                b: parseInt(hex.slice(4, 6), 16),
                a: parseInt(hex.slice(6, 8), 16) / 255
            };
        }

        if ((match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text))) {
            return {
                r: Math.min(255, +match[1]),
                g: Math.min(255, +match[2]),
                b: Math.min(255, +match[3]),
                a: match[4] === undefined ? 1 : Math.min(1, +match[4])
            };
        }

        if ((match = /^hsla?\(\s*([\d.]+)(?:deg)?\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text))) {
            const [r, g, b] = hslToRgb(+match[1], +match[2] / 100, +match[3] / 100);
            return { r, g, b, a: match[4] === undefined ? 1 : Math.min(1, +match[4]) };
        }

        if (text === 'white') return { r: 255, g: 255, b: 255, a: 1 };
        if (text === 'black') return { r: 0, g: 0, b: 0, a: 1 };
        return null;
    }

    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const l = (max + min) / 2;
        let h = 0;
        let s = 0;

        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
        }

        return [h, s, l];
    }

    function hslToRgb(h, s, l) {
        h = ((h % 360) + 360) % 360 / 360;
        if (s === 0) {
            const v = Math.round(l * 255);
            return [v, v, v];
        }

        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const channel = (t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };

        return [
            Math.round(channel(h + 1 / 3) * 255),
            Math.round(channel(h) * 255),
            Math.round(channel(h - 1 / 3) * 255)
        ];
    }

    // Farbton/Sättigung der Karte aus der Tönung (map.tint) des Presets ableiten
    function deriveVector(tint) {
        const color = parseCssColor(tint);
        if (!color) return null;
        const [hue, saturation] = rgbToHsl(color.r, color.g, color.b);
        return { hue, saturation: Math.min(0.3, saturation * 0.5), keepColor: 0.2 };
    }

    function resolveTheme(id) {
        const preset = getPreset(id) || BUILTIN_PRESETS[DEFAULT_PRESET];
        return {
            id: getPreset(id) ? id : DEFAULT_PRESET,
            label: preset.label,
            colors: { ...BASE_COLORS, ...preset.colors },
            map: {
                ...BASE_MAP,
                ...preset.map,
                vector: {
                    ...BASE_VECTOR,
                    ...(preset.map?.tint ? deriveVector(preset.map.tint) : null),
                    ...(preset.map?.vector || {})
                }
            },
            hud: preset.hud || null,
            icons: preset.icons || null,
            navDecor: preset.navDecor || null,
            corners: preset.corners || null,
            snow: preset.snow || null,
            particles: preset.particles || null,
            flight: preset.flight || null,
            hudHeader: preset.hudHeader || null,
            addButtonImage: preset.addButton || null
        };
    }

    const definition = {
        key: MODULE_KEY,
        name: 'Darkmode',
        version: MODULE_VERSION,
        settingsKey: SETTING_ENABLED,
        defaultEnabled: true,
        settings: {
            group: { de: 'Darkmode', en: 'Dark mode' },
            items: [{
                key: SETTING_ENABLED,
                type: 'toggle',
                label: {
                    de: 'Darkmode aktivieren (Seite wird neu geladen)',
                    en: 'Enable dark mode (reloads the page)'
                },
                default: true
            }, {
                key: SETTING_PRESET,
                type: 'select',
                label: {
                    de: 'Farbschema (Seite wird neu geladen)',
                    en: 'Color preset (reloads the page)'
                },
                default: DEFAULT_PRESET,
                options: presetOptions()
            }, {
                key: ACTION_ACHIEVEMENTS,
                type: 'button',
                label: {
                    de: 'Flugspiel – Treffer und Erfolge',
                    en: 'Flight game – hits and achievements'
                },
                buttonLabel: { de: '🏆 Auszeichnungen', en: '🏆 Achievements' },
                help: {
                    de: 'Klicke auf die fliegenden Objekte, um Punkte und Auszeichnungen zu sammeln.',
                    en: 'Click the flying objects to collect points and achievements.'
                }
            }]
        },
        async start(LEM) {
            setupFlightGame(LEM);
            if (themeRuntimeStarted) return;
            themeRuntimeStarted = true;

            root.addEventListener('LEM:setting-changed', async event => {
                const key = event.detail?.key;
                if (key === SETTING_PRESET) {
                    const id = LEM.settings.get(SETTING_PRESET, DEFAULT_PRESET);
                    if (!(id in BUILTIN_PRESETS)) {
                        try {
                            await loadPreset(id);
                        } catch (error) {
                            console.warn('[LE Manager - Darkmode] Preset konnte nicht geladen werden:',
                                         error?.message ?? error);
                        }
                    }
                    root.location.reload();
                }
            });

            const savedPresetId = LEM.settings.get(SETTING_PRESET, DEFAULT_PRESET);
            const selectedPresetId = savedPresetId === 'normal'
                ? DEFAULT_PRESET
                : savedPresetId;
            if (!getPreset(selectedPresetId)) {
                try {
                    await loadPreset(selectedPresetId);
                } catch (error) {
                    console.warn('[LE Manager - Darkmode] Preset konnte nicht geladen werden - Grau wird verwendet:',
                                 error?.message ?? error);
                }
            }

            const THEME = resolveTheme(selectedPresetId);
            refreshPresetsInBackground(selectedPresetId);
            const MAP_THEME = THEME.map;

            /* ========================= MAP ========================= */

            /* ========================= KARTE: VEKTOR-TILES (OpenMapTiles) / NEUE ENGINE ========================= */

            // Die Karte besteht inzwischen aus Vektor-Tiles (OpenMapTiles). Dort gibt es keine Bilder mehr, die man
            // filtern könnte: Die Farben stehen im Karten-Stil (je Layer). Es gibt drei Wege, sie zu ändern:
            //   1. 'api'    - über die Karten-Schnittstelle (setPaintProperty), falls die Engine sie anbietet
            //   2. 'style'  - beim Laden der Stil-Datei (JSON) die Farben umschreiben
            //   3. 'canvas' - Notlösung: Filter direkt auf die Karten-Zeichenfläche
            // Die alte Methode (Raster-Tiles filtern) bleibt für den Fall erhalten, dass sie noch gebraucht wird.

            const VECTOR_THEME = MAP_THEME.vector;
            const MAP_CANVAS_FALLBACK = true;      // false = keine Notlösung
            const MAP_CANVAS_FALLBACK_DELAY = 12000;
            const MAP_STYLE_URL_RE = /style/i;
            const OMT_SOURCE_LAYERS = new Set([
                'water', 'waterway', 'water_name', 'landcover', 'landuse', 'park', 'building', 'transportation',
                'transportation_name', 'boundary', 'place', 'poi', 'aeroway', 'aerodrome_label', 'mountain_peak',
                'housenumber', 'globallandcover'
            ]);
            const MAP_COLOR_PROPS = {
                background: ['background-color'],
                fill: ['fill-color', 'fill-outline-color'],
                line: ['line-color'],
                symbol: ['text-color', 'text-halo-color'],
                circle: ['circle-color', 'circle-stroke-color'],
                'fill-extrusion': ['fill-extrusion-color']
            };

            const mapThemedBy = new Set();
            const mapDiag = { bundle: null, exports: null };
            let mapFallbackStyle = null;



            // Die Karte ist MapLibre (Sprite-, Glyphen- und TileJSON-Anfragen), der Stil steckt im Spielcode und das
            // Karten-Objekt wird nicht exportiert. Deshalb wird es beim Erstellen abgefangen: Der Konstruktor setzt
            // Eigenschaften wie `_canvasContainer` und `painter`. Ein kurzzeitiger Setter auf Object.prototype
            // bekommt dabei die Karte als `this` und entfernt sich danach wieder.
            let capturedMap = null;

            function installMapTrap() {
                const names = ['_canvasContainer', 'painter', '_canvas'];
                const remove = () => {
                    for (const name of names) {
                        try { delete Object.prototype[name]; } catch (_) { /* nichts zu entfernen */ }
                    }
                };

                for (const name of names) {
                    try {
                        Object.defineProperty(Object.prototype, name, {
                            configurable: true,
                            enumerable: false,
                            get() { return undefined; },
                            set(value) {
                                // Normales Verhalten beibehalten: Wert als eigene Eigenschaft ablegen
                                Object.defineProperty(this, name, { value, writable: true, enumerable: true, configurable: true });

                                if (!capturedMap && typeof this.getStyle === 'function' && typeof this.setPaintProperty === 'function') {
                                    capturedMap = this;
                                    remove();
                                    console.info('[LE Manager - Darkmode] Karten-Objekt beim Erstellen abgefangen.');
                                }
                            }
                        });
                    } catch (_) { /* Falle nicht möglich */ }
                }

                // Falle nach zwei Minuten in jedem Fall wieder entfernen
                setTimeout(remove, 120000);
            }

            installMapTrap();

            function looksLikeMap(object) {
                return typeof object?.getStyle === 'function' &&
                    (typeof object?.setPaintProperty === 'function' || typeof object?.queryRenderedFeatures === 'function');
            }

            // Sucht in Objekten (Modul-Exporte, Vue-Komponente der Karte ...) nach einem MapLibre-ähnlichen Objekt
            function findMapLike(roots, maxDepth = 4, maxNodes = 3000) {
                const seen = new WeakSet();
                const queue = roots.filter(Boolean).map((value, index) => [value, 0, `root${index}`]);
                let visited = 0;

                while (queue.length && visited < maxNodes) {
                    const [value, depth, path] = queue.shift();
                    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) continue;
                    if (seen.has(value) || value === window || value === document || value instanceof Node) continue;

                    seen.add(value);
                    visited++;

                    if (looksLikeMap(value)) return { map: value, path };
                    if (depth >= maxDepth) continue;

                    let keys;
                    try {
                        keys = Reflect.ownKeys(value);
                    } catch (_) {
                        continue;
                    }

                    for (const key of keys.slice(0, 80)) {
                        if (typeof key === 'symbol') continue;
                        try {
                            queue.push([value[key], depth + 1, `${path}.${key}`]);
                        } catch (_) { /* Getter wirft - überspringen */ }
                    }
                }

                return null;
            }

            function mapElementRoots() {
                const element = document.querySelector('#map');
                if (!element) return [];

                const roots = [];
                for (const key of Object.getOwnPropertyNames(element)) {
                    if (!key.startsWith('_')) continue;
                    try {
                        roots.push(element[key]);
                        const component = element[key];
                        roots.push(component?.setupState, component?.exposed, component?.ctx);
                    } catch (_) { /* ignorieren */ }
                }
                return roots;
            }

            function markMapThemed(method) {
                if (!mapThemedBy.has(method)) {
                    mapThemedBy.add(method);
                    console.info(`[LE Manager - Darkmode] Karte eingefärbt über: ${method}`);
                }
                // Sobald die Farben direkt gesetzt wurden, wird die Notlösung nicht mehr gebraucht
                if (method !== 'canvas' && mapFallbackStyle) {
                    mapFallbackStyle.remove();
                    mapFallbackStyle = null;
                }
            }

            const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

            function transformCssColor(value, category, prop) {
                const color = parseCssColor(value);
                if (!color || color.a === 0) return value;

                const T = VECTOR_THEME;
                const tinted = T.saturation >= 0.02;
                const [h, s, l] = rgbToHsl(color.r, color.g, color.b);
                const brightness = T.brightness;
                let hue = tinted ? T.hue : h;
                let lightness;
                let saturation;

                if (prop === 'text-color' || prop === 'icon-color') {
                    lightness = clampNumber(0.62 + (1 - l) * 0.30, 0.55, 0.92) * Math.min(brightness, 1.1);
                    saturation = T.saturation * 0.5 + s * T.keepColor * 0.4;
                } else if (prop === 'text-halo-color' || prop === 'icon-halo-color') {
                    lightness = (0.07 + (1 - l) * 0.08) * brightness;
                    saturation = T.saturation * 0.8;
                } else if (prop === 'line-color' || prop === 'fill-outline-color' || prop === 'circle-stroke-color') {
                    if (category === 'water') {
                        lightness = (0.10 + l * 0.08) * brightness;
                        saturation = T.saturation * 1.2 + s * T.keepColor * 0.5;
                        if (!tinted) hue = 215;
                    } else {
                        lightness = (0.16 + l * 0.30) * brightness;
                        saturation = T.saturation * 0.8 + s * T.keepColor * 0.7;
                    }
                } else if (category === 'background') {
                    lightness = 0.10 * brightness;
                    saturation = T.saturation * 0.8;
                } else if (category === 'water') {
                    lightness = (0.055 + (1 - l) * 0.04) * brightness;
                    saturation = T.saturation * 1.3 + s * T.keepColor * 0.6;
                    if (!tinted) hue = 215;
                } else if (category === 'building') {
                    lightness = (0.15 + (1 - l) * 0.12) * brightness;
                    saturation = T.saturation + s * T.keepColor;
                } else {
                    lightness = (0.10 + (1 - l) * 0.12) * brightness;
                    saturation = T.saturation + s * T.keepColor;
                }

                const [r, g, b] = hslToRgb(hue, clampNumber(saturation, 0, 0.85), clampNumber(lightness, 0, 0.95));
                return color.a < 1
                    ? `rgba(${r}, ${g}, ${b}, ${+color.a.toFixed(3)})`
                    : `rgb(${r}, ${g}, ${b})`;
            }

            // Farben in Werten und Ausdrücken ersetzen (z. B. ["interpolate", ["linear"], ["zoom"], 5, "#fff", ...])
            function mapColorValue(value, transform) {
                if (typeof value === 'string') return transform(value);
                if (Array.isArray(value)) {
                    return value.map((item, index) =>
                        index === 0 && typeof item === 'string' ? item : mapColorValue(item, transform)
                    );
                }
                if (value && typeof value === 'object' && Array.isArray(value.stops)) {
                    return {
                        ...value,
                        stops: value.stops.map((stop) =>
                            Array.isArray(stop) ? [stop[0], mapColorValue(stop[1], transform)] : stop
                        )
                    };
                }
                return value;
            }

            function mapLayerCategory(layer) {
                if (layer.type === 'background') return 'background';
                const source = layer['source-layer'];
                if (!source || !OMT_SOURCE_LAYERS.has(source)) return null; // Spiel-Layer (Gebäude, Routen ...) nicht anfassen
                if (source === 'water' || source === 'waterway' || source === 'water_name') return 'water';
                if (source === 'building') return 'building';
                if (['transportation', 'transportation_name', 'boundary', 'aeroway'].includes(source)) return 'road';
                return 'land';
            }

            // Liefert [Eigenschaft, neuer Wert] für alle Farb-Eigenschaften eines Layers
            function themedPaintFor(layer, readValue) {
                if (layer.id === 'Buildings') return [];
                const category = mapLayerCategory(layer);
                const props = MAP_COLOR_PROPS[layer.type];
                if (!category || !props) return [];

                const result = [];
                for (const prop of props) {
                    let original = readValue(prop);
                    if (original === undefined) {
                        // Ohne Angabe ist Text schwarz - auf dunkler Karte unlesbar
                        if (prop === 'text-color' && layer.layout?.['text-field'] !== undefined) original = '#000000';
                        else continue;
                    }
                    result.push([prop, mapColorValue(original, (color) => transformCssColor(color, category, prop))]);
                }
                return result;
            }

            // Weg 2: Stil-Datei (JSON) umschreiben
            function recolorStyleSpec(style) {
                if (style.metadata?.leDarkmode) return 0; // schon umgefärbt
                let count = 0;
                for (const layer of style.layers) {
                    for (const [prop, value] of themedPaintFor(layer, (name) => layer.paint?.[name])) {
                        layer.paint = layer.paint || {};
                        layer.paint[prop] = value;
                        count++;
                    }
                }
                if (count) style.metadata = { ...style.metadata, leDarkmode: true };
                return count;
            }


            // Die Engine könnte fetch schon vor unserem Hook gesichert haben oder XHR nutzen. Deshalb zusätzlich
            // die Antwort-Methoden selbst abfangen - das greift unabhängig davon, wie die Anfrage gestellt wurde.
            const MAP_STYLE_HOST_RE = /^https:\/\/vector\.logistics-empire\.com\/styles\//i;
            const originalResponseJson = Response.prototype.json;
            const originalResponseText = Response.prototype.text;

            function isMapStyleUrl(url) {
                if (typeof url !== 'string' || !url) return false;
                return MAP_STYLE_HOST_RE.test(url) || /\/style\.json(?:$|\?)/i.test(url);
            }

            function recolorStyleText(text) {
                try {
                    const style = JSON.parse(text);
                    if (!Array.isArray(style?.layers) || !style.sources || !recolorStyleSpec(style)) return text;
                    markMapThemed('style');
                    return JSON.stringify(style);
                } catch (_) {
                    return text;
                }
            }

            function installStyleHooks() {
                if (Response.prototype.json.leDarkmodeHook) return;

                Response.prototype.json = async function () {
                    const data = await originalResponseJson.call(this);
                    try {
                        if (isMapStyleUrl(this.url) && Array.isArray(data?.layers) && data?.sources && recolorStyleSpec(data)) {
                            markMapThemed('style');
                        }
                    } catch (_) { /* Antwort unverändert lassen */ }
                    return data;
                };
                Response.prototype.json.leDarkmodeHook = true;

                Response.prototype.text = async function () {
                    const text = await originalResponseText.call(this);
                    return isMapStyleUrl(this.url) ? recolorStyleText(text) : text;
                };

                const xhrUrls = new WeakMap();
                const xhrTexts = new WeakMap();
                const originalOpen = XMLHttpRequest.prototype.open;

                XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                    try {
                        xhrUrls.set(this, new URL(String(url), location.href).href);
                    } catch (_) { /* ungültige URL ignorieren */ }
                    return originalOpen.call(this, method, url, ...rest);
                };

                for (const prop of ['responseText', 'response']) {
                    const descriptor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, prop);
                    if (!descriptor?.get) continue;

                    Object.defineProperty(XMLHttpRequest.prototype, prop, {
                        ...descriptor,
                        get() {
                            const value = descriptor.get.call(this);
                            const url = xhrUrls.get(this);
                            if (!url || this.readyState !== 4 || !isMapStyleUrl(url)) return value;

                            if (typeof value === 'string') {
                                if (!xhrTexts.has(this)) xhrTexts.set(this, recolorStyleText(value));
                                return xhrTexts.get(this);
                            }
                            if (Array.isArray(value?.layers) && recolorStyleSpec(value)) markMapThemed('style');
                            return value;
                        }
                    });
                }
            }

            installStyleHooks();

            async function recolorStyleResponse(url, response) {
                try {
                    const type = response.headers.get('content-type') || '';
                    if (!/json/i.test(type) && !/\.json(?:$|\?)/i.test(url)) return null;

                    const style = await originalResponseJson.call(response.clone());
                    if (!style || !Array.isArray(style.layers) || !style.sources) return null;
                    if (!recolorStyleSpec(style)) return null;

                    markMapThemed('style');
                    const headers = new Headers(response.headers);
                    headers.set('Content-Type', 'application/json');
                    headers.delete('Content-Length');
                    headers.delete('Content-Encoding');
                    return new Response(JSON.stringify(style), {
                        status: response.status,
                        statusText: response.statusText,
                        headers
                    });
                } catch (_) {
                    return null;
                }
            }

            // Weg 3: Notlösung auf der Zeichenfläche (ähnlich der früheren Tile-Bearbeitung)
            function installCanvasFallback() {
                if (!MAP_CANVAS_FALLBACK || mapThemedBy.size || mapFallbackStyle) return;

                mapFallbackStyle = document.createElement('style');
                mapFallbackStyle.id = 'le-darkmode-map-fallback-style';
                mapFallbackStyle.textContent = `
                    #map canvas.maplibregl-canvas {
                        filter: invert(88%) hue-rotate(180deg) brightness(102%) contrast(112%) saturate(70%) !important;
                    }

                    #map::after {
                        content: '';
                        position: absolute;
                        inset: 0;
                        pointer-events: none;
                        background: ${MAP_THEME.tint};
                        mix-blend-mode: soft-light;
                    }
                `;
                document.head.appendChild(mapFallbackStyle);
                mapThemedBy.add('canvas');
                console.info('[LE Manager - Darkmode] Karte: Weder Schnittstelle noch Stil-Datei gefunden - Notlösung (Filter auf der Zeichenfläche) aktiv.');
            }

            function logMapDiagnostics() {
                try {
                    const canvas = document.querySelector('#map canvas, canvas.maplibregl-canvas');
                    const methods = [
                        'getStyle', 'setStyle', 'setPaintProperty', 'getPaintProperty', 'getLayer', 'getSource',
                        'queryRenderedFeatures', 'getImage', 'updateImage', 'setTiles'
                    ].filter((name) => typeof gameMap?.[name] === 'function');

                    const patterns = new Map();
                    for (const entry of performance.getEntriesByType('resource')) {
                        const url = entry.name;
                        if (!/\.(pbf|mvt|pmtiles|json|webp|png|ttf|otf)(\?|$)|tile|style|sprite|glyph|font/i.test(url)) continue;
                        if (/\.(js|css|avif|svg)(\?|$)/i.test(url)) continue;
                        const pattern = url.split('?')[0].replace(/\d+/g, '#');
                        patterns.set(pattern, (patterns.get(pattern) || 0) + 1);
                    }

                    // Eigene globale Variablen der Seite (alles, was ein leeres Fenster nicht hat)
                    let customGlobals = [];
                    try {
                        const frame = document.createElement('iframe');
                        frame.style.display = 'none';
                        document.body.appendChild(frame);
                        const standard = new Set(Object.getOwnPropertyNames(frame.contentWindow));
                        frame.remove();
                        customGlobals = Object.getOwnPropertyNames(window).filter((name) => !standard.has(name)).slice(0, 60);
                    } catch (_) { /* ignorieren */ }

                    const describe = (value) => {
                        const type = typeof value;
                        if (value && (type === 'object' || type === 'function')) {
                            let keys = [];
                            try { keys = Object.keys(value).slice(0, 6); } catch (_) { /* ignorieren */ }
                            return `${type}${value.name ? `(${value.name})` : ''}${keys.length ? `{${keys.join(',')}}` : ''}`;
                        }
                        return type;
                    };

                    let exportsInfo = '';
                    if (mapDiag.module) {
                        exportsInfo = Object.keys(mapDiag.module).slice(0, 40)
                            .map((key) => `${key}:${describe(mapDiag.module[key])}`).join('\n  ');
                    }

                    const element = document.querySelector('#map');
                    const elementProps = element ? Object.getOwnPropertyNames(element).filter((key) => key.startsWith('_')) : [];

                    console.info(
                        '[LE Manager - Darkmode] Karten-Diagnose\n' +
                        `engine: ${canvas?.dataset?.engine || '-'}\n` +
                        `mapGefunden: ${Boolean(gameMap)} (beim Erstellen abgefangen: ${capturedMap ? 'ja' : 'nein'})\n` +
                        `methoden: ${methods.join(', ') || '-'}\n` +
                        `eingefaerbtUeber: ${[...mapThemedBy].join(', ') || '-'}\n` +
                        `bundle: ${mapDiag.bundle || '-'}\n` +
                        `#map-Eigenschaften: ${elementProps.join(', ') || '-'}\n` +
                        `eigene Globals: ${customGlobals.join(', ') || '-'}\n` +
                        `anfragen:\n  ${[...patterns.entries()].slice(0, 25).map(([pattern, count]) => `${count}x ${pattern}`).join('\n  ') || '-'}\n` +
                        `exports:\n  ${exportsInfo || '-'}`
                    );
                } catch (error) {
                    console.info('[LE Manager - Darkmode] Karten-Diagnose fehlgeschlagen:', error?.message ?? error);
                }
            }

            // Von Hand aufrufbar: leDarkmodeDiag() in der Konsole (am besten, wenn die Karte fertig geladen ist)
            window.leDarkmodeDiag = logMapDiagnostics;

            const TILE_URL = 'maps.missionchief.com/tile/';
            const nativeFetch = window.fetch.bind(window);
            const tileCache = new Map();
            const TILE_CACHE_LIMIT = 256;
            const MAP_COLOR_ALPHA = MAP_THEME.colorAlpha;
            const ROAD_WARMTH = MAP_THEME.roadWarmth;

            async function transformTile(blob) {
                const bitmap = await createImageBitmap(blob);
                const canvas = typeof OffscreenCanvas !== 'undefined'
                ? new OffscreenCanvas(bitmap.width, bitmap.height)
                : document.createElement('canvas');

                canvas.width = bitmap.width;
                canvas.height = bitmap.height;

                const ctx = canvas.getContext('2d');
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = 1;
                ctx.filter = 'grayscale(100%) invert(88%) brightness(102%) contrast(122%)';
                ctx.drawImage(bitmap, 0, 0);

                ctx.save();
                ctx.globalCompositeOperation = 'color';
                ctx.globalAlpha = MAP_COLOR_ALPHA;
                ctx.filter = MAP_THEME.colorFilter;
                ctx.drawImage(bitmap, 0, 0);
                ctx.restore();

                ctx.save();
                ctx.globalCompositeOperation = 'soft-light';
                ctx.globalAlpha = 1;
                ctx.fillStyle = MAP_THEME.tint;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.restore();

                ctx.save();
                ctx.globalCompositeOperation = 'soft-light';
                ctx.globalAlpha = ROAD_WARMTH;
                ctx.filter = MAP_THEME.roadFilter;
                ctx.drawImage(bitmap, 0, 0);
                ctx.restore();

                bitmap.close?.();

                if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' });
                return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            }

            async function getDarkTile(url, response) {
                // LRU: kein unbegrenztes Sammeln großer PNG-Blobs im Arbeitsspeicher.
                const cached = tileCache.get(url);
                if (cached) {
                    tileCache.delete(url);
                    tileCache.set(url, cached);
                    return cached;
                }
                const promise = (async () => transformTile(await response.blob()))();
                tileCache.set(url, promise);
                while (tileCache.size > TILE_CACHE_LIMIT) {
                    tileCache.delete(tileCache.keys().next().value);
                }
                try {
                    return await promise;
                } catch (error) {
                    if (tileCache.get(url) === promise) tileCache.delete(url);
                    throw error;
                }
            }

            window.fetch = async function (...args) {
                const input = args[0];
                const url = typeof input === 'string' ? input : input?.url;
                const response = await nativeFetch(...args);

                if (!url?.includes(TILE_URL)) {
                    if (url && response.ok && MAP_STYLE_URL_RE.test(url)) {
                        const themed = await recolorStyleResponse(url, response);
                        if (themed) return themed;
                    }
                    return response;
                }

                try {
                    const processingResponse = response.clone();
                    const darkBlob = await getDarkTile(url, processingResponse);
                    markMapThemed('raster-tiles');
                    const headers = new Headers(response.headers);
                    headers.set('Content-Type', 'image/png');
                    headers.delete('Content-Length');
                    headers.delete('Content-Encoding');

                    return new Response(darkBlob, {
                        status: response.status,
                        statusText: response.statusText,
                        headers
                    });
                } catch (error) {
                    if (
                        error?.name === 'AbortError' ||
                        /operation was aborted/i.test(error?.message || '')
                    ) return response;

                    console.warn('[LE Manager - Darkmode] Tile konnte nicht bearbeitet werden:', error);
                    return response;
                }
            };

            /* ========================= MAP BUILDINGS ========================= */

            const MAP_BUILDING_BRIGHTNESS = MAP_THEME.buildingBrightness;
            let gameMap = null;
            let mapTilesRefreshed = false;
            let mapBuildingTimer = null;
            let mapBuildingRetryInterval = null;
            let loggedBuildingLayer = false;
            const buildingSpriteOriginals = new Map();
            const processedBuildingSprites = new Set();

            function sleep(ms) {
                return new Promise(resolve => setTimeout(resolve, ms));
            }

            function getMapBundleUrl() {
                const urls = [
                    ...Array.from(document.querySelectorAll('link[href*="/assets/map-"][href$=".js"]')),
                    ...Array.from(document.querySelectorAll('script[src*="/assets/map-"][src$=".js"]'))
                ]
                .map(node => node.href || node.src)
                .filter(Boolean)
                .filter(url => /\/assets\/map-[A-Za-z0-9_-]+\.js(?:$|\?)/.test(url));
                return urls[0] || null;
            }

            async function waitForGameMap(timeoutMs = 20000) {
                const started = Date.now();

                while (Date.now() - started < timeoutMs) {
                    if (capturedMap) return capturedMap;

                    const url = getMapBundleUrl();
                    if (url) {
                        try {
                            const mod = await import(url);
                            mapDiag.bundle = url;
                            mapDiag.module = mod;
                            const candidates = [mod.t, mod.default, ...Object.values(mod)];
                            for (const candidate of candidates) {
                                if (looksLikeMap(candidate?.map)) return candidate.map;
                                if (looksLikeMap(candidate)) return candidate;
                            }

                            const found = findMapLike([mod, ...mapElementRoots()]);
                            if (found) {
                                console.info(`[LE Manager - Darkmode] Karten-Objekt gefunden unter: ${found.path}`);
                                return found.map;
                            }
                        } catch (error) {
                            console.debug('[LE Manager - Darkmode] Map-Engine noch nicht bereit:',
                                error?.message || error);
                        }
                    }
                    await sleep(250);
                }
                return null;
            }

            function getBuildingLayer() {
                if (!gameMap?.getStyle) return null;
                return gameMap.getStyle()?.layers?.find(layer => layer.id === 'Buildings') || null;
            }

            function getVisibleBuildingSpriteIds() {
                if (!gameMap || !getBuildingLayer()) return [];
                try {
                    const features = gameMap.queryRenderedFeatures({ layers: ['Buildings'] });
                    return [...new Set(
                        features.map(feature => feature.properties?.['icon-image']).filter(Boolean)
                    )];
                } catch (_) {
                    return [];
                }
            }

            function getSpritePixelSource(image) {
                if (!image) return null;
                if (image.data?.data && image.data?.width && image.data?.height) {
                    return image.data;
                }
                if (image.data && image.width && image.height) return image;
                return null;
            }

            function darkenBuildingSprite(spriteId) {
                if (!gameMap || !spriteId || processedBuildingSprites.has(spriteId)) return false;
                let image;
                try {
                    image = gameMap.getImage(spriteId);
                } catch (_) {
                    return false;
                }
                if (!image || image.sdf === true) return false;

                const source = getSpritePixelSource(image);
                if (!source?.data || !source?.width || !source?.height) return false;

                if (!buildingSpriteOriginals.has(spriteId)) {
                    buildingSpriteOriginals.set(spriteId, {
                        width: source.width,
                        height: source.height,
                        data: new Uint8ClampedArray(source.data)
                    });
                }

                const original = buildingSpriteOriginals.get(spriteId);
                const pixels = new Uint8ClampedArray(original.data);
                for (let i = 0; i < pixels.length; i += 4) {
                    pixels[i] = Math.round(pixels[i] * MAP_BUILDING_BRIGHTNESS);
                    pixels[i + 1] = Math.round(pixels[i + 1] * MAP_BUILDING_BRIGHTNESS);
                    pixels[i + 2] = Math.round(pixels[i + 2] * MAP_BUILDING_BRIGHTNESS);
                }

                try {
                    gameMap.updateImage(spriteId, {
                        width: original.width,
                        height: original.height,
                        data: pixels
                    });
                    processedBuildingSprites.add(spriteId);
                    return true;
                } catch (error) {
                    console.debug('[LE Manager - Darkmode] Gebäude-Sprite konnte nicht bearbeitet werden:',
                                  spriteId, error);
                    return false;
                }
            }

            function darkenVisibleBuildingSprites() {
                const layer = getBuildingLayer();
                if (!layer) {
                    return { layerFound: false, spritesFound: 0, spritesChanged: 0 };
                }

                if (!loggedBuildingLayer) {
                    loggedBuildingLayer = true;
                    console.log('[LE Manager - Darkmode] Gebäude-Layer gefunden:', {
                        id: layer.id,
                        type: layer.type,
                        source: layer.source,
                        sourceLayer: layer['source-layer'] || null
                    });
                }

                const iconIds = getVisibleBuildingSpriteIds();
                let changed = 0;
                for (const spriteId of iconIds) {
                    if (darkenBuildingSprite(spriteId)) changed++;
                }

                if (changed > 0) {
                    console.log(`[LE Manager - Darkmode] ${changed} neue Gebäude-Sprites auf ${Math.round(MAP_BUILDING_BRIGHTNESS * 100)} % Helligkeit gesetzt.`);
                }
                return {
                    layerFound: true,
                    spritesFound: iconIds.length,
                    spritesChanged: changed
                };
            }

            function scheduleBuildingSpriteDarkening() {
                clearTimeout(mapBuildingTimer);
                mapBuildingTimer = setTimeout(darkenVisibleBuildingSprites, 150);
            }

            function startBuildingRetryWindow() {
                clearInterval(mapBuildingRetryInterval);
                let attempts = 0;
                const maxAttempts = 60;

                const retry = () => {
                    attempts++;
                    const result = darkenVisibleBuildingSprites();
                    if (result.spritesFound > 0 || attempts >= maxAttempts) {
                        clearInterval(mapBuildingRetryInterval);
                        mapBuildingRetryInterval = null;
                        if (result.spritesFound === 0 && attempts >= maxAttempts) {
                            console.warn('[LE Manager - Darkmode] Nachladephase beendet, bisher keine sichtbaren Gebäude-Sprites gefunden.');
                        }
                    }
                };

                retry();
                mapBuildingRetryInterval = setInterval(retry, 500);
            }

            function refreshExistingMapTiles() {
                if (mapTilesRefreshed || !gameMap?.getSource) return mapTilesRefreshed;

                const source = gameMap.getSource('raster-tiles');
                const urls = source?.tiles;
                if (
                    typeof source?.setTiles !== 'function' ||
                    !Array.isArray(urls) ||
                    !urls.length
                ) return false;

                const originalUrls = urls.map(url =>
                                              url.replace(/([?&])lem_darkmode=1(?=&|$)/g, '').replace(/[?&]$/, '')
                                             );

                mapTilesRefreshed = true;
                try {
                    source.setTiles([...originalUrls]);
                    console.log('[LE Manager - Darkmode] Raster-Tiles mit Original-URLs einmalig neu geladen.');
                    return true;
                } catch (error) {
                    mapTilesRefreshed = false;
                    console.warn('[LE Manager - Darkmode] Raster-Tiles konnten nicht neu geladen werden:', error);
                    return false;
                }
            }

            let vectorTimer = null;
            let vectorSignature = '';
            let vectorSample = null;
            let loggedVectorSummary = false;
            const vectorOriginals = new Map();

            function vectorSampleStillThemed() {
                if (!vectorSample) return false;
                try {
                    return JSON.stringify(gameMap.getPaintProperty(vectorSample.id, vectorSample.prop)) === vectorSample.json;
                } catch (_) {
                    return false;
                }
            }

            // Weg 1: Farben über die Karten-Schnittstelle setzen
            function applyVectorTheme({ force = false } = {}) {
                if (!gameMap?.getStyle || typeof gameMap.setPaintProperty !== 'function') return false;

                let layers;
                try {
                    layers = gameMap.getStyle()?.layers;
                } catch (_) {
                    return false;
                }
                if (!Array.isArray(layers) || !layers.length) return false;

                const signature = `${layers.length}:${layers[0]?.id}:${layers[layers.length - 1]?.id}`;
                const themed = vectorSample && signature === vectorSignature && vectorSampleStillThemed();
                if (!force && themed) return true;

                // Stil wurde ersetzt oder erweitert: Original-Farben neu einlesen
                vectorOriginals.clear();
                vectorSample = null;

                let changed = 0;
                let layerCount = 0;
                const skipped = [];

                for (const layer of layers) {
                    const entries = themedPaintFor(layer, (prop) => {
                        const key = `${layer.id}|${prop}`;
                        if (!vectorOriginals.has(key)) vectorOriginals.set(key, layer.paint?.[prop]);
                        return vectorOriginals.get(key);
                    });

                    if (!entries.length) {
                        if (layer.type !== 'raster' && layer.type !== 'background' && skipped.length < 8) skipped.push(layer.id);
                        continue;
                    }

                    layerCount++;
                    for (const [prop, value] of entries) {
                        try {
                            gameMap.setPaintProperty(layer.id, prop, value);
                            changed++;
                            if (!vectorSample) {
                                vectorSample = {
                                    id: layer.id,
                                    prop,
                                    json: JSON.stringify(gameMap.getPaintProperty(layer.id, prop))
                                };
                            }
                        } catch (_) { /* Eigenschaft nicht änderbar - überspringen */ }
                    }
                }

                vectorSignature = signature;

                if (changed > 0) {
                    markMapThemed('api');
                    if (!loggedVectorSummary) {
                        loggedVectorSummary = true;
                        console.info(
                            `[LE Manager - Darkmode] Vektor-Karte: ${changed} Farben in ${layerCount} Layern angepasst.`,
                            skipped.length ? `Nicht angepasst (Beispiele): ${skipped.join(', ')}` : ''
                        );
                    }
                }

                return changed > 0;
            }

            function scheduleVectorTheme() {
                clearTimeout(vectorTimer);
                vectorTimer = setTimeout(() => applyVectorTheme(), 250);
            }

            async function startMapBuildingDarkmode() {
                setTimeout(installCanvasFallback, MAP_CANVAS_FALLBACK_DELAY);
                setTimeout(logMapDiagnostics, 15000);

                gameMap = await waitForGameMap();
                if (!gameMap) {
                    console.warn('[LE Manager - Darkmode] Map-Engine für Gebäude-Darkmode nicht gefunden.');
                    return;
                }

                applyVectorTheme({ force: true });

                // Direkt nach dem Erstellen ist der Stil evtl. noch nicht geladen - bis zu 30 s lang prüfen
                let vectorTries = 0;
                const vectorPoll = setInterval(() => {
                    if (applyVectorTheme() || ++vectorTries >= 30) clearInterval(vectorPoll);
                }, 1000);

                gameMap.on?.('styledata', scheduleVectorTheme);
                gameMap.on?.('idle', scheduleVectorTheme);
                gameMap.on?.('load', scheduleVectorTheme);

                startBuildingRetryWindow();
                refreshExistingMapTiles();
                gameMap.on?.('styledata', refreshExistingMapTiles);
                gameMap.on?.('idle', refreshExistingMapTiles);
                gameMap.on?.('idle', scheduleBuildingSpriteDarkening);
                gameMap.on?.('moveend', scheduleBuildingSpriteDarkening);
                gameMap.on?.('zoomend', scheduleBuildingSpriteDarkening);
                gameMap.on?.('load', startBuildingRetryWindow);
            }

            /* ========================= COLORS / HELPERS ========================= */

            const COLORS = THEME.colors;

            function setStyles(element, styles) {
                for (const [property, value] of Object.entries(styles)) {
                    element.style.setProperty(property, value, 'important');
                }
            }

            function collect(root, selector) {
                const result = [];
                if (root?.matches?.(selector)) result.push(root);
                if (root?.querySelectorAll) result.push(...root.querySelectorAll(selector));
                return result;
            }

            function isExcludedUI(element) {
                return element instanceof Element && Boolean(
                    element.closest('.order-header') ||
                    element.closest('.bb-base-button.variant--spend')
                );
            }

            function isBlueAccordionToggle(button) {
                return button.classList.contains('bb-accordion-toggle-icon') &&
                    Boolean(button.closest('.p-accordionheader.panel__header'));
            }

            function navButtonGradient(active = false) {
                return active
                    ? `linear-gradient(to bottom, ${COLORS.navActiveTop} 0%, ${COLORS.navActiveBottom} 100%)`
                : `linear-gradient(to bottom, ${COLORS.navButtonTop} 0%, ${COLORS.navButtonBottom} 100%)`;
            }

            function applyRootTokens() {
                const html = document.documentElement;
                if (!html) return;
                setStyles(html, {
                    '--color-nav-button-bg': COLORS.navMid,
                    '--color-surface-app': COLORS.surface,
                    '--color-backdrop-dim': COLORS.backdrop,
                    '--color-bar-bg': COLORS.surfaceRaised,
                    '--color-border-default': COLORS.border,
                    '--color-border-strong': COLORS.borderStrong,
                    '--color-line-light': COLORS.lineLight,
                    '--color-line-dark': COLORS.lineDark,
                    '--color-surface-field': COLORS.input,
                    '--color-border-field': COLORS.border,
                    '--color-text-field': COLORS.text,
                    '--entry-card-content-background-color': COLORS.surface,
                    '--entry-card-content-background-gradient': 'none',
                    '--entry-card-border-color': COLORS.border,
                    '--entry-card-header-text-color': COLORS.text,
                    '--entry-card-shadow': '0 2px 5px rgba(0,0,0,0.28)',
                    '--background-gradient-card-info': 'none'
                });
            }

            function styleBottomNavigation(root) {
                for (const nav of collect(root, '.bottom-navigation')) {
                    setStyles(nav, {
                        '--grd-t': COLORS.navTop,
                        '--grd-v': COLORS.navMid,
                        '--grd-b': COLORS.navBottom,
                        '--border-color': COLORS.navBorder
                    });
                }
            }

            /* ========================= BUTTONS ========================= */

            function styleNavButton(button) {
                if (isExcludedUI(button)) return;
                button.classList.add('le-darkmode-managed');
                const active = button.getAttribute('active') === 'true';
                const gradient = navButtonGradient(active);

                setStyles(button, {
                    background: gradient,
                    'background-image': gradient,
                    'background-color': active
                    ? COLORS.navActiveBottom : COLORS.navButtonBottom,
                    color: COLORS.text,
                    'border-color': active
                    ? COLORS.navActiveBorder : COLORS.navBorder,
                    'box-shadow': active
                    ? `inset 0 1px rgba(255,255,255,0.09), inset 0 -1px rgba(0,0,0,0.24), inset 0 0 0 1px ${COLORS.navActiveGlow}`
                    : 'inset 0 1px rgba(255,255,255,0.06), inset 0 -1px rgba(0,0,0,0.22)'
                });
            }

            function styleNeutralButton(button) {
                if (isExcludedUI(button)) return;
                button.classList.add('le-darkmode-managed');

                if (isBlueAccordionToggle(button)) {
                    const gradient = `linear-gradient(to bottom, ${COLORS.allianceBlueTop}, ${COLORS.allianceBlueBottom})`;
                    setStyles(button, {
                        background: gradient,
                        'background-color': COLORS.allianceBlueBottom,
                        'background-image': gradient,
                        color: COLORS.text,
                        'border-color': COLORS.allianceBlueBorder,
                        'box-shadow': 'inset 0 1px rgba(255,255,255,0.08)'
                    });
                    return;
                }

                const active = button.getAttribute('active') === 'true';
                setStyles(button, {
                    background: active ? COLORS.buttonActive : COLORS.button,
                    'background-image': 'none',
                    color: COLORS.text,
                    'border-color': active ? COLORS.buttonActiveBorder : COLORS.border,
                    'box-shadow': active
                    ? `inset 0 0 0 1px ${COLORS.buttonActiveGlow}`
                    : 'inset 0 1px rgba(255,255,255,0.05)'
                });
            }

            function styleNormalButton(button) {
                if (isExcludedUI(button)) return;
                button.classList.add('le-darkmode-managed', 'le-normal-action');
                const enabled = !button.disabled;
                button.classList.toggle('le-enabled-action', enabled);
                setStyles(button, enabled ? {
                    background: COLORS.buttonEnabled,
                    'background-image': 'none',
                    'border-color': COLORS.buttonEnabledBorder,
                    color: '#f1fff5',
                    filter: 'none',
                    'box-shadow': 'inset 0 1px rgba(255,255,255,0.14), 0 1px 3px rgba(0,0,0,0.20)'
                } : {
                    background: COLORS.buttonDisabled,
                    'background-image': 'none',
                    'border-color': COLORS.buttonDisabledBorder,
                    color: COLORS.buttonDisabledText,
                    filter: 'brightness(0.88) saturate(0.65)',
                    'box-shadow': 'inset 0 1px rgba(255,255,255,0.03)'
                });
            }

            function styleInputs(root) {
                for (const field of collect(root, '.p-iconfield')) {
                    if (isExcludedUI(field)) continue;
                    setStyles(field, {
                        background: COLORS.input,
                        'background-image': 'none',
                        'border-color': COLORS.border,
                        color: COLORS.text
                    });
                }

                for (const input of collect(root, 'input.p-inputtext')) {
                    if (isExcludedUI(input)) continue;
                    setStyles(input, {
                        background: 'transparent',
                        color: COLORS.text
                    });
                }
            }

            function styleSVGs(root) {
                const darkStrokes = new Set(['black', '#000', '#000000', '#212121']);
                for (const path of collect(root, '.bb-svg path')) {
                    if (isExcludedUI(path)) continue;
                    if (darkStrokes.has(path.getAttribute('stroke'))) {
                        setStyles(path, { stroke: COLORS.text });
                    }
                }
            }

            function styleContainers(root) {
                for (const element of collect(root, '.navigation-container')) {
                    setStyles(element, {
                        background: COLORS.backdrop,
                        'background-image': 'none'
                    });
                }
                for (const group of collect(root, '.bb-button-group')) {
                    if (isExcludedUI(group)) continue;
                    setStyles(group, {
                        background: COLORS.surface,
                        'background-image': 'none',
                        'border-color': COLORS.border
                    });
                }
            }

            /* ========================= ORDERS ========================= */

            function getOrderPanels(root) {
                const panels = new Set();
                if (root?.matches?.('.panel-content')) panels.add(root);
                if (root?.querySelectorAll) {
                    for (const panel of root.querySelectorAll('.panel-content')) panels.add(panel);
                }
                if (root instanceof Element) {
                    const parentPanel = root.closest('.panel-content');
                    if (parentPanel) panels.add(parentPanel);
                }
                return [...panels];
            }

            function styleOrderPanels(root) {
                for (const panel of getOrderPanels(root)) {
                    const amountLabels = panel.querySelectorAll('.bb-amount-label');
                    if (!amountLabels.length) continue;
                    panel.classList.remove('le-order-normal', 'le-order-partial', 'le-order-blocked');

                    const hasAlert = Boolean(
                        panel.querySelector('.bb-item-row-tile .bb-amount-label.variant--alert')
                    );
                    const hasWarning = Boolean(
                        panel.querySelector('.bb-item-row-tile .bb-amount-label.variant--warning')
                    );

                    if (hasAlert) panel.classList.add('le-order-blocked');
                    else if (hasWarning) panel.classList.add('le-order-partial');
                    else panel.classList.add('le-order-normal');
                }
            }

            function replacePresetIcons(root) {
                const icons = THEME.icons;
                if (!icons) return;
                for (const img of collect(root, 'img[data-key]')) {
                    const url = icons[img.dataset.key];
                    if (!url || img.getAttribute('src') === url) continue;
                    img.removeAttribute('srcset');
                    img.setAttribute('src', url);
                    img.style.objectFit = 'contain';
                }
            }

            function processUI(root) {
                if (!(root instanceof Element)) return;
                styleBottomNavigation(root);
                styleContainers(root);
                styleInputs(root);
                styleSVGs(root);
                styleOrderPanels(root);
                replacePresetIcons(root);

                for (const button of collect(root, '.bb-base-button.variant--nav.theme--light')) {
                    styleNavButton(button);
                }
                for (const button of collect(root, '.bb-base-button.variant--neutral.theme--light')) {
                    styleNeutralButton(button);
                }
                for (const button of collect(root, '.bb-base-button.variant--normal.theme--light')) {
                    styleNormalButton(button);
                }
            }

            /* ========================= CSS ========================= */

            function installDarkmodeCSS() {
                if (document.getElementById('le-darkmode-ui-style')) return;

                const style = document.createElement('style');
                style.id = 'le-darkmode-ui-style';
                style.textContent = `
                     /* ================= GENERAL ================= */

                     html body {
                         color: ${COLORS.text};
                     }

                     .p-inputtext::placeholder {
                         color: ${COLORS.muted} !important;
                     }

                     .hud-window {
                         background-color: ${COLORS.surface} !important;
                     }

                     /* ================= PANEL HEADER ================= */

                     .panel-header:not(:has(.order-header)),
                     .panel__header.category-card__header {
                         --panel-header-background-gradient: none !important;
                         background: ${COLORS.header} !important;
                         background-image: none !important;
                         color: ${COLORS.text} !important;
                         border-color: ${COLORS.border} !important;
                     }

                     .panel-header:not(:has(.order-header)) .text-h2,
                     .panel__header.category-card__header .text-h2 {
                         color: ${COLORS.textStrong} !important;
                     }

                     .panel-header:not(:has(.order-header)) .sub-title,
                     .panel__header.category-card__header .text-p2-700 {
                         color: ${COLORS.textSub} !important;
                     }

                     /* ================= TOP HUD HEADER ================= */

                     .hud-header button[data-tutorial-id="browser-powersearch"] {
                         background-color: ${COLORS.header} !important;
                     }

                     ${THEME.hudHeader ? `
                     .hud-header .browser-resource-bubble.resource-bar,
                     button.browser-resource-bubble.resource-event-bubble,
                     .hud-header button[data-tutorial-id="browser-powersearch"] {
                         background-image: url("${THEME.hudHeader}") !important;
                         background-size: cover !important;
                         background-position: center center !important;
                         background-repeat: no-repeat !important;
                     }
                     ` : ''}

                     /* ================= CORNER ================= */

                     #le-darkmode-corner-decor {
                         pointer-events: none !important;
                         z-index: 1 !important;
                     }

                     .hud-root.le-darkmode-corner-host > #le-darkmode-corner-decor {
                         position: absolute !important;
                         top: 0 !important;
                         left: 0 !important;
                         width: 100% !important;
                         height: 0 !important;
                         overflow: visible !important;
                         z-index: 1 !important;
                     }

                     .hud-root.le-darkmode-corner-host > .hud-header {
                         z-index: 30 !important;
                     }

                     .hud-root.le-darkmode-corner-host > .hud-footer {
                         z-index: 20 !important;
                     }

                     @media (max-width: 900px), (hover: none) and (pointer: coarse) {
                         #le-darkmode-corner-decor {
                             display: none !important;
                         }
                     }

                     @media (min-width: 901px) and (pointer: fine) {
                         #le-darkmode-corner-decor > div {
                             width: 320px !important;
                             height: 320px !important;
                         }
                     }

                     /* ================= NAVBAR ================= */

                     .bottom-navigation > div:first-child {
                         background: linear-gradient(
                             to bottom,
                             ${COLORS.navTop} 0%,
                             ${COLORS.navMid} 52%,
                             ${COLORS.navBottom} 100%
                         ) !important;
                     }

                     #navigationTeleport {
                         --grd-t: ${COLORS.navTop} !important;
                         --grd-v: ${COLORS.navMid} !important;
                         --grd-b: ${COLORS.navBottom} !important;
                         --border-color: ${COLORS.navBorder} !important;
                         background: linear-gradient(
                             to bottom, ${COLORS.navTop}, ${COLORS.navBottom}
                         ) !important;
                         border-color: ${COLORS.navBorder} !important;
                     }

                     /* ================= MAIN BROWSER NAV ================= */

                     .browser-nav [data-tutorial-id="navigation-left-section"],
                     .browser-nav [data-tutorial-id="navigation-right-section"] {
                         background: linear-gradient(
                             to bottom,
                             ${COLORS.navButtonTop} 0%,
                             ${COLORS.navButtonBottom} 100%
                         ) !important;
                         background-color: ${COLORS.navButtonBottom} !important;
                         background-image: linear-gradient(
                             to bottom,
                             ${COLORS.navButtonTop} 0%,
                             ${COLORS.navButtonBottom} 100%
                         ) !important;
                         border-color: ${COLORS.navBorder} !important;
                         box-shadow:
                             inset 0 1px rgba(255,255,255,0.06),
                             inset 0 -1px rgba(0,0,0,0.22),
                             0 2px 4px rgba(0,0,0,0.24) !important;
                     }

                     .browser-nav [data-tutorial-id="navigation-left-section"] .border-r-4,
                     .browser-nav [data-tutorial-id="navigation-right-section"] .border-r-4 {
                         border-color: ${COLORS.navBorder} !important;
                     }

                     .browser-nav,
                     .browser-nav .bb-base-button {
                         ${COLORS.navGlowHover
                    ? `--bg-glow-hover: ${COLORS.navGlowHover} !important;`
                : ''}
                     }

                     /* ================= HUD FOOTER ================= */

                     .hud-footer .footer {
                         --bg-color: ${COLORS.hudBar} !important;
                     }

                     .hud-footer .footer > div[class*="bg-(--bg-color)"] {
                         background: ${COLORS.hudBar} !important;
                         background-color: ${COLORS.hudBar} !important;
                     }

                     .hud-footer .footer > div > svg > path {
                         fill: ${COLORS.hudBar} !important;
                     }

                     .hud-footer button[aria-label="Neueste Welt-Chat-Nachricht anzeigen"] {
                         background: linear-gradient(
                             to bottom, ${COLORS.navButtonTop}, ${COLORS.navButtonBottom}
                         ) !important;
                         background-color: ${COLORS.navButtonBottom} !important;
                         background-image: linear-gradient(
                             to bottom, ${COLORS.navButtonTop}, ${COLORS.navButtonBottom}
                         ) !important;
                         border-color: ${COLORS.navBorder} !important;
                     }

                     /* ================= ENTRY CARDS ================= */

                     .bb-entry-card {
                         --entry-card-content-background-color: ${COLORS.surface} !important;
                         --entry-card-content-background-gradient: none !important;
                         --entry-card-border-color: ${COLORS.border} !important;
                         --entry-card-header-text-color: ${COLORS.text} !important;
                     }

                     .bb-entry-card__content {
                         background: ${COLORS.surface} !important;
                         background-image: none !important;
                         border-color: ${COLORS.border} !important;
                     }

                     .bb-half-mask.bb-entry-card__header {
                         --half-mask-background-color: ${COLORS.header} !important;
                         --half-mask-background-gradient: none !important;
                         --half-mask-after-background-color: transparent !important;
                         --entry-card-header-text-color: ${COLORS.text} !important;
                         background: ${COLORS.header} !important;
                         background-image: none !important;
                         border-color: ${COLORS.border} !important;
                         color: ${COLORS.text} !important;
                     }

                     .bb-half-mask.bb-entry-card__header::after {
                         background: transparent !important;
                     }

                     /* ================= BUILDING CARDS ================= */

                     .building-card {
                         --entry-card-content-background-color: ${COLORS.surface} !important;
                         --entry-card-content-background-gradient: none !important;
                         --entry-card-border-color: ${COLORS.border} !important;
                         background: ${COLORS.surface} !important;
                         background-image: none !important;
                         border-color: ${COLORS.border} !important;
                         color: ${COLORS.text} !important;
                     }

                     .building-card.status--info {
                         background: ${COLORS.info} !important;
                         background-image: none !important;
                     }

                     .building-card.status--alert {
                         background: ${COLORS.buildingAlert} !important;
                         background-color: ${COLORS.buildingAlert} !important;
                         background-image: none !important;
                         border-color: ${COLORS.buildingAlertBorder} !important;
                         color: ${COLORS.text} !important;
                     }

                     /* ================= BUILDING HEADERS ================= */

                     #scrollContainer > .bb-heading.bb-heading--2 {
                         background: ${COLORS.header} !important;
                         background-color: ${COLORS.header} !important;
                         background-image: none !important;
                     }

                     /* ================= BUSINESS PARTNERS SUB HEADER ================= */

                     .sub-header:has([data-tutorial-id="order-location-add"]) {
                         --subheader-bar-background-color: ${COLORS.header} !important;
                         background: ${COLORS.header} !important;
                     }

                     /* ================= FILTER AND SORT BAR ================= */

                     .panel-content .bb-filter-and-sort-bar {
                         background: ${COLORS.header} !important;
                         background-color: ${COLORS.header} !important;
                         background-image: none !important;
                     }

                     /* ================= PRODUCTION ================= */

                     [class*="background-gradient-card-info"] {
                         --background-gradient-card-info: none !important;
                         background: ${COLORS.surface} !important;
                         background-image: none !important;
                         border-color: ${COLORS.border} !important;
                     }

                     /* ================= EINHEITLICHES DUNKELBLAU ================= */

                     .hud-window:has(.lao-container) .bb-heading,
                     .hud-window:has(.lao-container) .lao-rewards,
                     .hud-window:has(.lao-container) .lao-container,
                     .hud-window:has(.lao-container) .lao-log > div,
                     #scrollContainer section:has(.bg-alliance-revenue-text),
                     .hud-window:has(#headerBar [aria-label*="Rangliste"]) .bb-heading,
                     .hud-window:has(#headerBar [aria-label*="Rangliste"]) .bb-entry-card__content,
                     .hud-window:has(#headerBar [aria-label*="Rangliste"])
                         section.bg-linear-to-b.from-surface-panel-top.to-surface-panel-bottom,
                     .hud-window:has(#headerBar [aria-label*="Ranking"]) .bb-heading,
                     .hud-window:has(#headerBar [aria-label*="Ranking"]) .bb-entry-card__content,
                     .hud-window:has(#headerBar [aria-label*="Ranking"])
                         section.bg-linear-to-b.from-surface-panel-top.to-surface-panel-bottom {
                         background: linear-gradient(
                             to bottom, ${COLORS.allianceBlueTop}, ${COLORS.allianceBlueBottom}
                         ) !important;
                         background-color: ${COLORS.allianceBlueBottom} !important;
                         background-image: linear-gradient(
                             to bottom, ${COLORS.allianceBlueTop}, ${COLORS.allianceBlueBottom}
                         ) !important;
                         border-color: ${COLORS.allianceBlueBorder} !important;
                     }

                     /* ================= STANDARD HEADER BAR ================= */

                     #headerBar > div.relative.flex.flex-nowrap.items-center {
                         --header-bar-background-color: ${COLORS.header} !important;
                         --header-bar-border-color: ${COLORS.border} !important;
                         background: ${COLORS.header} !important;
                         background-color: ${COLORS.header} !important;
                         background-image: none !important;
                         border-color: ${COLORS.border} !important;
                         color: ${COLORS.text} !important;
                     }

                     #headerBar > div.relative.flex.flex-nowrap.items-center .text-h1 {
                         color: ${COLORS.text} !important;
                     }

                     #headerBar > div.relative.flex.flex-nowrap.items-center .text-p2-700 {
                         color: ${COLORS.textSub} !important;
                     }

                     .hud-window:has(.lao-container) .lao-rewards {
                         --lao-rewards-bg-color: ${COLORS.allianceBlueBottom} !important;
                         --lao-rewards-bg-gradient: none !important;
                     }

                     .hud-window:has(.lao-container) .lao-container {
                         --lao-container-in-progress-bg-color: ${COLORS.allianceBlueBottom} !important;
                     }

                     .hud-window:has(.lao-container) .lao-log > div {
                         --lao-log-bg-color: ${COLORS.allianceBlueBottom} !important;
                         --lao-log-bg-gradient: none !important;
                     }

                     #scrollContainer section:has(.bg-alliance-revenue-text)
                         .bg-alliance-revenue-text {
                         background: ${COLORS.allianceBlueBottom} !important;
                         background-color: ${COLORS.allianceBlueBottom} !important;
                         background-image: none !important;
                     }

                     /* ================= ALLIANZ PROFIL HEADER ================= */

                     #headerBar > section:has(.bg-alliance-revenue-text) {
                         background: ${COLORS.header} !important;
                         background-color: ${COLORS.header} !important;
                         background-image: none !important;
                         border-color: ${COLORS.border} !important;
                         color: ${COLORS.text} !important;
                     }

                     #headerBar > section:has(.bg-alliance-revenue-text)
                         .bg-alliance-revenue-text,
                     #headerBar > section:has(.bg-alliance-revenue-text)
                         .bg-alliance-member-box-bg {
                         background: ${COLORS.surfaceRaised} !important;
                         background-color: ${COLORS.surfaceRaised} !important;
                         background-image: none !important;
                         color: ${COLORS.text} !important;
                         border-color: ${COLORS.border} !important;
                     }

                     /* ================= ACCORDION ================= */

                     .p-accordionheader.panel__header {
                         --panel-header-background-gradient: linear-gradient(
                             to bottom, ${COLORS.allianceBlueTop}, ${COLORS.allianceBlueBottom}
                         ) !important;
                         background: linear-gradient(
                             to bottom, ${COLORS.allianceBlueTop}, ${COLORS.allianceBlueBottom}
                         ) !important;
                         background-color: ${COLORS.allianceBlueBottom} !important;
                         background-image: linear-gradient(
                             to bottom, ${COLORS.allianceBlueTop}, ${COLORS.allianceBlueBottom}
                         ) !important;
                         border-color: ${COLORS.allianceBlueBorder} !important;
                         color: ${COLORS.text} !important;
                     }

                     .p-accordionheader.panel__header .bb-accordion-toggle-icon {
                         border-color: ${COLORS.allianceBlueBorder} !important;
                     }

                     /* ================= CHAT ================= */

                     .bg-message-bg.text-text-inverse {
                         background: linear-gradient(
                             to bottom, ${COLORS.allianceBlueTop}, ${COLORS.allianceBlueBottom}
                         ) !important;
                         background-color: ${COLORS.allianceBlueBottom} !important;
                         color: ${COLORS.text} !important;
                     }

                     .bg-message-bg.text-text-inverse .text-h4,
                     .bg-message-bg.text-text-inverse .text-p2-500,
                     .bg-message-bg.text-text-inverse .text-p3-400 {
                         color: ${COLORS.text} !important;
                     }

                     .bg-message-bg.text-text-inverse > .bg-message-bg {
                         background: ${COLORS.allianceBlueBottom} !important;
                         background-color: ${COLORS.allianceBlueBottom} !important;
                     }

                     /* ================= CONVERSATION CARDS ================= */

                     .conversation__card > div {
                         background: linear-gradient(
                             to bottom, ${COLORS.allianceBlueTop}, ${COLORS.allianceBlueBottom}
                         ) !important;
                         background-color: ${COLORS.allianceBlueBottom} !important;
                         background-image: linear-gradient(
                             to bottom, ${COLORS.allianceBlueTop}, ${COLORS.allianceBlueBottom}
                         ) !important;
                         border-color: ${COLORS.allianceBlueBorder} !important;
                         color: ${COLORS.text} !important;
                     }

                     .conversation__card > div .text-h2,
                     .conversation__card > div .text-p2-700,
                     .conversation__card > div .text-p2-500,
                     .conversation__card > div .text-p3,
                     .conversation__card > div .bb-markdown,
                     .conversation__card > div .bb-markdown p,
                     .conversation__card > div .bb-markdown h1,
                     .conversation__card > div .bb-markdown h2,
                     .conversation__card > div .bb-markdown h3,
                     .conversation__card > div .bb-markdown li,
                     .conversation__card > div .bb-markdown strong {
                         color: ${COLORS.text} !important;
                     }

                     .conversation__card > div .bb-link {
                         color: #8fc7ff !important;
                     }

                     /* ================= RANKING / PLAYER / ALLIANCE ================= */

                     .hud-window a[href^="#/player/"] > .wrapper,
                     .hud-window a[href^="#/alliances/"] > .wrapper {
                         background: linear-gradient(
                             to bottom, ${COLORS.allianceBlueTop}, ${COLORS.allianceBlueBottom}
                         ) !important;
                         background-color: ${COLORS.allianceBlueBottom} !important;
                         background-image: linear-gradient(
                             to bottom, ${COLORS.allianceBlueTop}, ${COLORS.allianceBlueBottom}
                         ) !important;
                         color: ${COLORS.text} !important;
                     }

                     .hud-window a[href^="#/player/"] > .wrapper .text-h3,
                     .hud-window a[href^="#/player/"] > .wrapper .text-h3-clamp,
                     .hud-window a[href^="#/alliances/"] > .wrapper .text-h3,
                     .hud-window a[href^="#/alliances/"] > .wrapper .text-h3-clamp,
                     .hud-window a[href^="#/player/"] > .wrapper h2,
                     .hud-window a[href^="#/alliances/"] > .wrapper h2 {
                         color: ${COLORS.text} !important;
                     }

                     .hud-window a[href^="#/player/"][aria-current="page"] > .wrapper,
                     .hud-window a[href^="#/alliances/"][aria-current="page"] > .wrapper,
                     .hud-window a[href^="#/player/"].active > .wrapper,
                     .hud-window a[href^="#/alliances/"].active > .wrapper,
                     .hud-window a[href^="#/player/"].selected > .wrapper,
                     .hud-window a[href^="#/alliances/"].selected > .wrapper {
                         background: linear-gradient(
                             to bottom, ${COLORS.selectedTop}, ${COLORS.selectedBottom}
                         ) !important;
                         background-image: linear-gradient(
                             to bottom, ${COLORS.selectedTop}, ${COLORS.selectedBottom}
                         ) !important;
                     }

                     /* ================= ORDER STATUS ================= */

                     .panel-content.le-order-normal {
                         background: ${COLORS.surface} !important;
                         background-color: ${COLORS.surface} !important;
                         background-image: none !important;
                     }

                     .panel-content.le-order-partial {
                         background: linear-gradient(
                             110deg,
                             #75622f 0%,
                             #655738 20%,
                             #554b3b 38%,
                             #45413d 57%,
                             #39373a 70%,
                             ${COLORS.surface} 88%
                         ) !important;
                         border-color: #98803f !important;
                         box-shadow:
                             inset 4px 0 0 rgba(202,163,62,0.82),
                             inset 0 0 18px rgba(126,95,29,0.08) !important;
                     }

                     .panel-content.le-order-blocked {
                         background: linear-gradient(
                             110deg,
                             #b83441 0%,
                             #9c313d 18%,
                             #7e323d 38%,
                             #64353e 58%,
                             #49333a 78%,
                             ${COLORS.surface} 100%
                         ) !important;
                         border-color: #d65360 !important;
                         box-shadow:
                             inset 5px 0 0 rgba(255, 72, 88, 0.95),
                             inset 0 0 22px rgba(175, 32, 48, 0.18) !important;
                     }

                     .panel-content.le-order-normal > div.relative[class*="min-h-[66px]"],
                     .panel-content.le-order-partial > div.relative[class*="min-h-[66px]"],
                     .panel-content.le-order-blocked > div.relative[class*="min-h-[66px]"] {
                         background: transparent !important;
                         background-color: transparent !important;
                         background-image: none !important;
                     }

                     .panel-content.le-order-normal .bb-item-row-tile-bg.neutral,
                     .panel-content.le-order-partial .bb-item-row-tile-bg.neutral,
                     .panel-content.le-order-blocked .bb-item-row-tile-bg.neutral {
                         background: transparent !important;
                         background-color: transparent !important;
                         background-image: none !important;
                         border-color: transparent !important;
                         box-shadow: none !important;
                     }

                     /* ================= ITEM TILES ================= */

                     .bb-base-tile .bb-beveled-tile.tile--normal,
                     .bb-base-tile .bb-beveled-tile.tile--normal .tile__fill,
                     .bb-base-tile > .bb-base-tile__content {
                         background: transparent !important;
                         background-color: transparent !important;
                         background-image: none !important;
                     }

                     .bb-base-tile .bb-beveled-tile.tile--normal .tile__frame {
                         border-color: rgba(255,255,255,0.15) !important;
                         box-shadow:
                             inset 0 1px rgba(255,255,255,0.05),
                             inset 0 -1px rgba(0,0,0,0.15) !important;
                     }

                     .bb-base-tile .bb-base-tile__content img {
                         filter:
                             drop-shadow(0 1px 1px rgba(255,255,255,0.10))
                             drop-shadow(0 2px 2px rgba(0,0,0,0.20));
                     }

                     .bb-base-tile:hover .bb-beveled-tile.tile--normal,
                     .bb-base-tile:hover .bb-beveled-tile.tile--normal .tile__fill,
                     .bb-base-tile:hover > .bb-base-tile__content {
                         background: rgba(255,255,255,0.06) !important;
                         background-image: none !important;
                     }

                     /* ================= ADD BUILDING ================= */

                     ${THEME.addButtonImage ? `
                     button[data-tutorial-id="add-building-button"] {
                         background: transparent !important;
                         background-image: url("${THEME.addButtonImage}") !important;
                         background-size: 110% 130% !important;
                         background-position: center !important;
                         background-repeat: no-repeat !important;
                         border: 1px solid ${COLORS.addButtonBorder} !important;
                         box-shadow:
                             inset 0 1px rgba(255,255,255,0.06),
                             0 2px 5px rgba(0,0,0,0.22) !important;
                     }

                     button[data-tutorial-id="add-building-button"]:hover {
                         border-color: ${COLORS.addButtonHoverBorder} !important;
                         filter: brightness(1.05) !important;
                     }
                     ` : `
                     button[data-tutorial-id="add-building-button"] {
                         background: ${COLORS.addButton} !important;
                         background-color: ${COLORS.addButton} !important;
                         background-image: none !important;
                         border: 1px solid ${COLORS.addButtonBorder} !important;
                         box-shadow:
                             inset 0 1px rgba(255,255,255,0.06),
                             0 2px 5px rgba(0,0,0,0.22) !important;
                     }

                     button[data-tutorial-id="add-building-button"]:hover {
                         background: ${COLORS.addButtonHover} !important;
                         background-color: ${COLORS.addButtonHover} !important;
                         border-color: ${COLORS.addButtonHoverBorder} !important;
                         filter: brightness(1.05) !important;
                     }
                     `}

                     /* ================= BUTTON HOVER ================= */

                     .bb-base-button.le-darkmode-managed:hover {
                         filter: brightness(1.07);
                     }

                     .bb-base-button.variant--normal.le-enabled-action:hover {
                         background: ${COLORS.buttonEnabledHover} !important;
                         border-color: ${COLORS.buttonEnabledHoverBorder} !important;
                         filter: brightness(1.04) !important;
                     }

                     .bb-base-button.variant--normal:disabled {
                         cursor: default;
                     }

                     /* ================= LABELS ================= */

                     .bb-base-tile .bb-amount-label {
                         color: #f5f5f6 !important;
                     }

                     .panel-content .bb-amount-label.variant--warning,
                     .panel-content .bb-amount-label.variant--warning *,
                     .panel-content .bb-amount-label.variant--alert,
                     .panel-content .bb-amount-label.variant--alert * {
                         color: #151416 !important;
                     }

                     .bb-label-container.bb-amount-label.variant--success,
                     .bb-label-container.bb-amount-label.variant--success span,
                     .bb-label-container.bb-amount-label.variant--success number-flow-vue {
                         color: #55d987 !important;
                     }
                 `;

                document.head.appendChild(style);
            }

            /* ========================= ECK-DEKORATION ========================= */

            function findCornerHudRoot() {
                return [...document.querySelectorAll('.hud-root')]
                    .find(el => el.querySelector('.hud-header')) ||
                    document.querySelector('.hud-root');
            }

            function ensureCornerDecorPlacement() {
                const layer = document.getElementById('le-darkmode-corner-decor');
                if (!layer) return;
                const hudRoot = findCornerHudRoot();
                if (!hudRoot) return;

                if (!hudRoot.classList.contains('le-darkmode-corner-host')) {
                    hudRoot.classList.add('le-darkmode-corner-host');
                }

                if (layer.parentElement !== hudRoot) {
                    hudRoot.prepend(layer);
                }
            }

            function installCornerDecor() {
                document.getElementById('le-darkmode-corner-decor')?.remove();

                const corners = THEME.corners;
                if (!corners?.image || root.matchMedia?.(
                    '(max-width: 900px), (hover: none) and (pointer: coarse)'
                ).matches) return;

                const size = corners.size ?? 200;
                const layer = document.createElement('div');
                layer.id = 'le-darkmode-corner-decor';
                layer.style.cssText =
                    'position:fixed;left:0;top:0;width:100%;height:0;pointer-events:none;' +
                    `z-index:${corners.zIndex ?? 0};opacity:${corners.opacity ?? 1};`;

                for (const side of ['left', 'right']) {
                    const el = document.createElement('div');
                    el.style.cssText =
                        `position:absolute;top:0;${side}:0;width:${size}px;height:${size}px;pointer-events:none;` +
                        (corners.filter ? `filter:${corners.filter};` : '') +
                        `background:url("${corners.image}") no-repeat 0 0 / 100% 100%;` +
                        (side === 'right' ? 'transform:scaleX(-1);' : '');
                    layer.appendChild(el);
                }

                document.body.prepend(layer);
                ensureCornerDecorPlacement();
            }

            /* ========================= GEMEINSAME PARTIKEL-ENGINE ========================= */

            // Die Animation läuft bevorzugt in einem Web Worker auf einem OffscreenCanvas.
            // Der Browser zeigt den Canvas dann direkt aus dem Worker an, ähnlich wie
            // CSS-Animationen (z. B. den Ladekreis). Dadurch läuft sie weiter, wenn die
            // Seite den Haupt-Thread blockiert (lange Ladevorgänge, große Auswertungen).
            // Ist ein Worker nicht möglich (z. B. wegen einer Content-Security-Policy oder
            // in älteren Browsern), läuft dieselbe Engine wie bisher im Haupt-Thread.

            let particleFrame = null;
            let particleResizeHandler = null;
            let particleVisibilityHandler = null;
            let particleWorker = null;
            let particleWorkerDisabled = false;
            let particleRun = 0;

            function createParticleEngine(cfg, sprite, frameWidth, frameHeight) {
                let width = 0;
                let height = 0;
                let particles = [];
                let last = 0;

                const random = (min, max) => {
                    return min + Math.random() * (max - min);
                };

                // Einzelnes Partikel erzeugen.
                const createParticle = anywhere => {
                    const size = random(cfg.sizeMin, cfg.sizeMax);

                    const depth =
                          (size - cfg.sizeMin) /
                          ((cfg.sizeMax - cfg.sizeMin) || 1);

                    return {
                        x: random(0, width),

                        y: anywhere
                        ? random(0, height)
                        : -size * 2,

                        size,

                        speed:
                        cfg.speedMin +
                        (cfg.speedMax - cfg.speedMin) *
                        (0.25 + 0.75 * depth),

                        // Zufällige Startposition innerhalb der Sinusbewegung.
                        phase: random(0, Math.PI * 2),

                        // Frequenz in vollständigen Schwingungen pro Sekunde.
                        frequency: random(
                            cfg.swayFrequencyMin,
                            cfg.swayFrequencyMax
                        ),

                        // Seitliche Auslenkung in Pixeln.
                        amplitude: random(
                            cfg.swayAmplitudeMin,
                            cfg.swayAmplitudeMax
                        ),

                        // Anfangsdrehung.
                        angle: random(0, Math.PI * 2),

                        // Drehgeschwindigkeit von Grad/s nach Radiant/s.
                        angularSpeed: random(
                            cfg.rotationSpeedMin,
                            cfg.rotationSpeedMax
                        ) * Math.PI / 180,

                        // Zufälliges Motiv aus dem Sprite-Sheet.
                        frame: Math.floor(random(0, cfg.frames)),

                        // Größere Partikel erscheinen etwas kräftiger.
                        alpha:
                        cfg.opacity *
                        (0.55 + 0.45 * depth)
                    };
                };

                return {
                    // Zeichenfläche in CSS-Pixeln; erzeugt beim ersten Aufruf alle Partikel.
                    resize(w, h) {
                        width = w;
                        height = h;

                        if (!particles.length) {
                            particles = Array.from(
                                { length: cfg.count },
                                () => createParticle(true)
                            );
                        }
                    },
                    reset(now) {
                        last = now;
                    },
                    draw(ctx, now) {
                        const delta = Math.min(
                            (now - last) / 1000,
                            0.1
                        );

                        last = now;

                        ctx.clearRect(0, 0, width, height);
                        ctx.fillStyle = cfg.color;

                        for (let i = 0; i < particles.length; i++) {
                            const p = particles[i];
                            p.y += p.speed * delta;
                            p.x += cfg.wind * delta;
                            p.phase += p.frequency * 2 * Math.PI * delta;
                            p.angle += p.angularSpeed * delta;
                            if (p.y - p.size > height) {
                                particles[i] = createParticle(false);
                                continue;
                            }
                            // Horizontal außerhalb des Bildes wieder einsteigen.
                            const margin = p.size + p.amplitude;
                            if (p.x < -margin) {
                                p.x = width + margin;
                            }
                            if (p.x > width + margin) {
                                p.x = -margin;
                            }
                            // Hier entsteht die eigentliche Segelbewegung.
                            const drawX =
                                  p.x +
                                  Math.sin(p.phase) * p.amplitude;

                            ctx.globalAlpha = p.alpha;

                            if (sprite) {
                                // HERBST: Motiv aus dem Sprite-Sheet zeichnen und rotieren.
                                const drawHeight =
                                      p.size * frameHeight / frameWidth;

                                ctx.save();
                                ctx.translate(drawX, p.y);
                                ctx.rotate(p.angle);
                                ctx.drawImage(
                                    sprite,
                                    p.frame * frameWidth,
                                    0,
                                    frameWidth,
                                    frameHeight,
                                    -p.size / 2,
                                    -drawHeight / 2,
                                    p.size,
                                    drawHeight
                                );

                                ctx.restore();
                            } else {
                                // WINTER: Schneeflocke als Kreis zeichnen.
                                ctx.beginPath();
                                ctx.arc(
                                    drawX,
                                    p.y,
                                    p.size,
                                    0,
                                    Math.PI * 2
                                );

                                ctx.fill();
                            }
                        }
                    }
                };
            }

            // Quelltext des Workers: gemeinsame Engine + eigene Zeichenschleife.
            function buildParticleWorkerSource() {
                return `'use strict';
                ${createParticleEngine.toString()}

                let canvas = null;
                let ctx = null;
                let engine = null;
                let running = false;
                let frameHandle = null;
                let timerHandle = null;
                let dpr = 1;
                let width = 0;
                let height = 0;
                let minInterval = 0;
                let lastDraw = -Infinity;

                // Eine Größenänderung setzt den Canvas-Zustand zurück, daher alles neu einstellen.
                const applySize = () => {
                    canvas.width = Math.round(width * dpr);
                    canvas.height = Math.round(height * dpr);
                    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'high';
                    engine.resize(width, height);
                };

                const frame = now => {
                    frameHandle = null;
                    timerHandle = null;
                    if (!running) return;
                    // Bildrate begrenzen: Zwischenframes auslassen (der Browser rendert dann auch nichts neu).
                    if (now - lastDraw >= minInterval) {
                        lastDraw = now;
                        engine.draw(ctx, now);
                    }
                    schedule();
                };

                const schedule = () => {
                    if (!running) return;
                    if (typeof requestAnimationFrame === 'function') {
                        frameHandle = requestAnimationFrame(frame);
                    } else {
                        timerHandle = setTimeout(() => frame(performance.now()), 16);
                    }
                };

                const stop = () => {
                    running = false;
                    if (frameHandle !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameHandle);
                    if (timerHandle !== null) clearTimeout(timerHandle);
                    frameHandle = null;
                    timerHandle = null;
                };

                const start = () => {
                    if (running) return;
                    running = true;
                    lastDraw = -Infinity;
                    engine.reset(performance.now());
                    schedule();
                };

                self.onmessage = event => {
                    const m = event.data;
                    try {
                        if (m.type === 'init') {
                            canvas = m.canvas;
                            ctx = canvas.getContext('2d');
                           if (!ctx) {
                                self.postMessage({ type: 'fail', reason: 'Kein 2D-Kontext' });
                                return;
                            }
                            engine = createParticleEngine(m.cfg, m.sprite, m.frameWidth, m.frameHeight);
                            minInterval = Math.max(0, 1000 / (m.cfg.fps || 30) - 4);
                            dpr = m.dpr;
                            width = m.width;
                            height = m.height;
                            applySize();
                            self.postMessage({ type: 'ready' });
                            if (!m.paused) start();
                        } else if (m.type === 'resize' && engine) {
                            dpr = m.dpr;
                            width = m.width;
                            height = m.height;
                            applySize();
                        } else if (m.type === 'pause') {
                            stop();
                        } else if (m.type === 'resume' && engine) {
                            start();
                        }
                    } catch (error) {
                        self.postMessage({ type: 'fail', reason: String((error && error.message) || error) });
                    }
                };
                `;
            }

            // Laufende Animation vollständig entfernen.
            function stopParticles() {
                if (particleFrame !== null) {
                    cancelAnimationFrame(particleFrame);
                    particleFrame = null;
                }

                if (particleWorker) {
                    particleWorker.terminate();
                    particleWorker = null;
                }

                if (particleResizeHandler) {
                    root.removeEventListener('resize', particleResizeHandler);
                    particleResizeHandler = null;
                }

                if (particleVisibilityHandler) {
                    document.removeEventListener(
                        'visibilitychange',
                        particleVisibilityHandler
                    );
                    particleVisibilityHandler = null;
                }

                document.getElementById('le-darkmode-particles')?.remove();
                document.getElementById('le-darkmode-snow')?.remove();
            }

            async function installParticles() {
                const run = ++particleRun;

                stopParticles();

                const cfg = THEME.particles;

                if (!cfg) return;

                if (root.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
                    return;
                }

                let sprite = null;

                if (cfg.render === 'sprite') {
                    sprite = new Image();
                    sprite.decoding = 'async';
                    sprite.src = cfg.image;

                    try {
                        await sprite.decode();

                        if (!sprite.naturalWidth || !sprite.naturalHeight) {
                            throw new Error('Leeres Bild');
                        }
                    } catch (error) {
                        console.warn(
                            '[LE Darkmode] Partikel-Grafik konnte nicht geladen werden:',
                            error
                        );
                        return;
                    }

                    if (run !== particleRun) return;
                }

                const frameWidth = sprite
                ? sprite.naturalWidth / cfg.frames
                : 0;

                const frameHeight = sprite
                ? sprite.naturalHeight
                : 0;

                const createCanvas = () => {
                    const element = document.createElement('canvas');

                    element.id = 'le-darkmode-particles';

                    element.style.cssText =
                        'position:fixed;' +
                        'left:0;' +
                        'top:0;' +
                        'width:100%;' +
                        'height:100%;' +
                        'pointer-events:none;' +
                        `z-index:${cfg.zIndex};`;

                    return element;
                };

                // Bei hochauflösenden Bildschirmen reichen 1,5 Pixel pro CSS-Pixel:
                // die Blätter bleiben ausreichend scharf, die Zeichenfläche wird aber
                // fast halb so groß (deutlich weniger CPU/GPU-Last).
                const pixelRatio = () => Math.min(root.devicePixelRatio || 1, 1.5);

                // Mindestabstand zwischen zwei Frames (Bildraten-Begrenzung).
                const minInterval = Math.max(0, 1000 / (cfg.fps || 30) - 4);

                /* ---------- Variante 1: Worker + OffscreenCanvas ---------- */

                const createSpriteBitmap = async () => {
                    const targetWidth = Math.min(
                        Math.max(Math.ceil(cfg.sizeMax * 4), 64),
                        512
                    );

                    const targetHeight = Math.max(
                        1,
                        Math.round(targetWidth * frameHeight / frameWidth)
                    );

                    const sheet = document.createElement('canvas');

                    sheet.width = targetWidth * cfg.frames;
                    sheet.height = targetHeight;

                    const sheetCtx = sheet.getContext('2d');

                    if (!sheetCtx) throw new Error('Kein 2D-Kontext');

                    sheetCtx.imageSmoothingQuality = 'high';

                    sheetCtx.drawImage(
                        sprite,
                        0,
                        0,
                        sprite.naturalWidth,
                        sprite.naturalHeight,
                        0,
                        0,
                        sheet.width,
                        sheet.height
                    );

                    return {
                        bitmap: await createImageBitmap(sheet),
                        frameWidth: targetWidth,
                        frameHeight: targetHeight
                    };
                };

                // Liefert true, wenn der Worker läuft, sonst false (dann Haupt-Thread).
                const startWorker = async () => {
                    if (
                        particleWorkerDisabled ||
                        typeof Worker !== 'function' ||
                        typeof OffscreenCanvas !== 'function' ||
                        typeof Blob !== 'function' ||
                        typeof createImageBitmap !== 'function' ||
                        typeof URL?.createObjectURL !== 'function' ||
                        !('transferControlToOffscreen' in HTMLCanvasElement.prototype)
                    ) {
                        return false;
                    }

                    let spriteData = null;

                    if (sprite) {
                        try {
                            spriteData = await createSpriteBitmap();
                        } catch (error) {
                            console.warn(
                                '[LE Darkmode] Sprite für Worker nicht erzeugt:',
                                error
                            );
                            return false;
                        }

                        if (run !== particleRun) {
                            spriteData.bitmap.close();
                            return true;
                        }
                    }

                    return new Promise(resolve => {
                        let settled = false;
                        let worker = null;
                        let url = '';
                        let workerCanvas = null;
                        let timeout = null;

                        const cleanup = () => {
                            clearTimeout(timeout);
                            worker?.terminate();
                            if (url) URL.revokeObjectURL(url);
                            workerCanvas?.remove();
                        };

                        const fail = reason => {
                            if (!settled) {
                                // Start nicht möglich: auf den Haupt-Thread ausweichen.
                                settled = true;
                                cleanup();

                                console.warn(
                                    '[LE Darkmode] Partikel-Worker nicht verfügbar, ' +
                                    'nutze Haupt-Thread:',
                                    reason
                                );

                                resolve(false);
                                return;
                            }
                            if (run === particleRun) {
                                console.warn(
                                    '[LE Darkmode] Partikel-Worker ausgefallen, ' +
                                    'nutze Haupt-Thread:',
                                    reason
                                );

                                particleWorkerDisabled = true;
                                void installParticles();
                            }
                        };

                        try {
                            workerCanvas = createCanvas();
                            document.body.appendChild(workerCanvas);

                            const offscreen = workerCanvas.transferControlToOffscreen();

                            url = URL.createObjectURL(
                                new Blob(
                                    [buildParticleWorkerSource()],
                                    { type: 'text/javascript' }
                                )
                            );

                            worker = new Worker(url);

                            worker.onerror = event => {
                                fail(event?.message || 'Worker-Fehler');
                            };

                            worker.onmessage = event => {
                                const message = event.data;

                                if (message?.type === 'fail') {
                                    fail(message.reason);
                                    return;
                                }

                                if (message?.type !== 'ready' || settled) return;

                                settled = true;
                                clearTimeout(timeout);
                                URL.revokeObjectURL(url);

                                if (run !== particleRun) {
                                    worker.terminate();
                                    workerCanvas.remove();
                                    resolve(true);
                                    return;
                                }

                                particleWorker = worker;
                                particleResizeHandler = () => {
                                    worker.postMessage({
                                        type: 'resize',
                                        width: root.innerWidth,
                                        height: root.innerHeight,
                                        dpr: pixelRatio()
                                    });
                                };

                                root.addEventListener('resize', particleResizeHandler);

                                // Im Hintergrund-Tab pausieren, danach fortsetzen.
                                particleVisibilityHandler = () => {
                                    worker.postMessage({
                                        type: document.hidden ? 'pause' : 'resume'
                                    });
                                };

                                document.addEventListener(
                                    'visibilitychange',
                                    particleVisibilityHandler
                                );
                                resolve(true);
                            };

                            timeout = setTimeout(
                                () => fail('Zeitüberschreitung beim Start'),
                                3000
                            );

                            const transfer = [offscreen];
                            if (spriteData) transfer.push(spriteData.bitmap);

                            worker.postMessage(
                                {
                                    type: 'init',
                                    canvas: offscreen,
                                    cfg,
                                    sprite: spriteData ? spriteData.bitmap : null,
                                    frameWidth: spriteData ? spriteData.frameWidth : 0,
                                    frameHeight: spriteData ? spriteData.frameHeight : 0,
                                    width: root.innerWidth,
                                    height: root.innerHeight,
                                    dpr: pixelRatio(),
                                    paused: document.hidden
                                },
                                transfer
                            );
                        } catch (error) {
                            fail(error);
                        }
                    });
                };

                if (await startWorker()) return;
                if (run !== particleRun) return;

                /* ---------- Variante 2 (Fallback): Haupt-Thread ---------- */

                const canvas = createCanvas();
                document.body.appendChild(canvas);
                const ctx = canvas.getContext('2d');

                if (!ctx) {
                    canvas.remove();
                    return;
                }

                const engine = createParticleEngine(
                    cfg,
                    sprite,
                    frameWidth,
                    frameHeight
                );

                // Canvas an Bildschirmgröße und Pixeldichte anpassen.
                const resize = () => {
                    const dpr = pixelRatio();
                    const width = root.innerWidth;
                    const height = root.innerHeight;

                    canvas.width = Math.round(width * dpr);
                    canvas.height = Math.round(height * dpr);

                    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

                    engine.resize(width, height);
                };

                resize();

                particleResizeHandler = resize;
                root.addEventListener('resize', resize);

                engine.reset(performance.now());
                let lastDraw = -Infinity;

                const tick = now => {
                    if (run !== particleRun) return;

                    // Keine Berechnung im Hintergrund.
                    if (document.hidden) {
                        particleFrame = null;
                        return;
                    }

                    if (now - lastDraw >= minInterval) {
                        lastDraw = now;
                        engine.draw(ctx, now);
                    }
                    particleFrame = requestAnimationFrame(tick);
                };

                // Animation nach Rückkehr zum Tab fortsetzen.
                particleVisibilityHandler = () => {
                    if (
                        !document.hidden &&
                        particleFrame === null &&
                        run === particleRun
                    ) {
                        lastDraw = -Infinity;
                        engine.reset(performance.now());
                        particleFrame = requestAnimationFrame(tick);
                    }
                };

                document.addEventListener(
                    'visibilitychange',
                    particleVisibilityHandler
                );

                if (!document.hidden) {
                    particleFrame = requestAnimationFrame(tick);
                }
            }

            /* ========================= THEMENGESTEUERTE FLUGANIMATION ========================= */

            const FLIGHT = THEME.flight;
            let flightIndex = 0;
            let flightActive = false;
            const activeFlights = new Set();

            root.addEventListener('hashchange', () => {
                if (root.location.hash.startsWith('#/map')) return;
                for (const flight of activeFlights) {
                    flight.animation.cancel();
                    flight.img.remove();
                }
            });

            async function flyTheme(options = {}) {
                if (!FLIGHT?.image || !root.location.hash.startsWith('#/map')) return;
                const d = FLIGHT;
                const direction = options.direction || (
                    d.direction === 'alternate'
                    ? (flightIndex++ % 2 ? 'rtl' : 'ltr')
                    : d.direction
                );

                const width = Math.min(
                    Math.max(root.innerWidth * d.widthFactor, d.minWidth),
                    d.maxWidth
                );
                const speed = d.speed;
                const minDuration = d.minDuration;
                const swing = d.swing;
                const top = Number.isFinite(options.top) ? options.top : null;

                const img = new Image();
                img.src = d.image;
                img.alt = '';
                img.draggable = false;

                try {
                    await img.decode();
                } catch (error) {
                    console.warn(
                        '[LE Manager - Darkmode] Theme-Flugbild konnte nicht geladen werden:',
                        error
                    );
                    return;
                }

                if (!root.location.hash.startsWith('#/map')) return;

                const vw = document.documentElement.clientWidth;
                const vh = root.innerHeight;
                const w = Number.isFinite(options.width) && options.width > 0
                ? options.width : width;
                const h = w * img.naturalHeight / img.naturalWidth;
                const dir = direction === 'rtl' ? -1 : 1;
                const amplitude = vh * swing;
                const yMin = amplitude + 8;
                const yMax = Math.max(yMin, vh * 0.55 - h);
                const y0 = top ?? yMin + Math.random() * (yMax - yMin);
                const distance = vw + w;
                const duration = Math.max(minDuration, distance / speed * 1000);

                const steps = 90;
                const keyframes = [];

                for (let i = 0; i <= steps; i++) {
                    const t = i / steps;
                    const x = dir === 1
                    ? -w + t * distance
                    : vw - t * distance;
                    const phase = 2 * Math.PI * d.waves * t;
                    const y = y0 + amplitude * Math.sin(phase);
                    const dy = amplitude * 2 * Math.PI * d.waves * Math.cos(phase);
                    const rot = (Math.atan2(dy, distance) * 180 / Math.PI) * dir;
                    keyframes.push({
                        offset: t,
                        transform: `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${rot.toFixed(2)}deg) scaleX(${dir})`
                    });
                }

                img.style.cssText = [
                    'position:fixed',
                    'left:0',
                    'top:0',
                    `width:${w}px`,
                    `height:${h}px`,
                    'max-width:none',
                    'max-height:none',
                    'margin:0',
                    'padding:0',
                    'border:0',
                    'pointer-events:auto',
                    'cursor:crosshair',
                    'touch-action:manipulation',
                    'user-select:none',
                    '-webkit-user-select:none',
                    'z-index:2147483647',
                    'will-change:transform'
                ].join(';');

                document.documentElement.appendChild(img);
                const animation = img.animate(keyframes, {
                    duration,
                    easing: 'linear',
                    fill: 'both'
                });
                const activeFlight = { img, animation };
                activeFlights.add(activeFlight);
                let collected = false;
                const collect = event => {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation?.();
                    if (collected || !img.isConnected) return;
                    collected = true;
                    const rect = img.getBoundingClientRect();
                    const x = Number.isFinite(event.clientX) && event.clientX > 0 ? event.clientX : rect.left + rect.width / 2;
                    const y = Number.isFinite(event.clientY) && event.clientY > 0 ? event.clientY : rect.top + rect.height / 2;
                    img.remove();
                    animation.cancel();
                    collectFlightHit(x, y);
                };
                img.addEventListener('pointerdown', event => {
                    if (event.pointerType === 'mouse' && event.button !== 0) return;
                    collect(event);
                });
                img.addEventListener('click', collect);
                img.tabIndex = 0;
                img.setAttribute('role', 'button');
                img.setAttribute('aria-label', gameText('hits'));
                img.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') collect(event);
                });

                try {
                    await animation.finished;
                } catch (_) {

                } finally {
                    activeFlights.delete(activeFlight);
                    img.remove();
                }
            }

            root.flyTheme = flyTheme;

            async function flyActiveTheme() {
                if (
                    !FLIGHT?.image ||
                    !root.location.hash.startsWith('#/map') ||
                    flightActive
                ) return;

                flightActive = true;
                try {
                    await flyTheme();
                } catch (error) {
                    console.warn('[LE Manager - Darkmode] Theme-Flug fehlgeschlagen:', error);
                } finally {
                    flightActive = false;
                }
            }

            if (FLIGHT?.image) {
                setInterval(flyActiveTheme, FLIGHT.intervalMs);
            }

            /* ========================= MENÜLEISTE-DEKORATION ========================= */

            function installNavDecor() {
                document.getElementById('le-darkmode-nav-decor-style')?.remove();

                const decor = THEME.navDecor;
                if (!decor?.image) return;

                const gradient =
                      `linear-gradient(to bottom, ${COLORS.navButtonTop} 0%, ${COLORS.navButtonBottom} 100%)`;
                const size = decor.size ?? 'auto 100%';

                const rule = (selector, position) => `
                     html .browser-nav ${selector} {
                         background-image: url("${decor.image}"), ${gradient} !important;
                         background-repeat: repeat-x, no-repeat !important;
                         background-size: ${size}, 100% 100% !important;
                         background-position: ${position}, 0 0 !important;
                     }
                 `;

                const style = document.createElement('style');
                style.id = 'le-darkmode-nav-decor-style';

                const mobileRule = `
                     @media (max-width: 900px), (hover: none) and (pointer: coarse) {
                         html .bottom-navigation,
                         html .bottom-navigation > div:first-child,
                         html .browser-nav {
                             background-image: url("${decor.image}"), ${gradient} !important;
                             background-repeat: repeat-x, no-repeat !important;
                             background-size: ${size}, 100% 100% !important;
                             background-position: center center, center center !important;
                         }

                         html .browser-nav [data-tutorial-id="navigation-left-section"],
                         html .browser-nav [data-tutorial-id="navigation-right-section"] {
                             background-position: center center, center center !important;
                         }
                     }
                 `;

                style.textContent =
                    rule(
                    '[data-tutorial-id="navigation-left-section"]',
                    decor.positionLeft ?? '0 0'
                ) +
                    rule(
                    '[data-tutorial-id="navigation-right-section"]',
                    decor.positionRight ?? '0 0'
                ) +
                    mobileRule;

                document.head.appendChild(style);
            }

            /* ========================= HUD-DEKORATION ========================= */

            let hudDecorTimer = null;

            function buildHudDecorElement(hud) {
                const { left, right, ground } = hud.assets;
                const scale = hud.scale ?? 1;
                const px = value => Math.round(value * scale);

                const images = [
                    `url("${left.url}")`,
                    `url("${right.url}")`
                ];
                const positions = ['left bottom', 'right bottom'];
                const sizes = [
                    `${px(left.w)}px ${px(left.h)}px`,
                    `${px(right.w)}px ${px(right.h)}px`
                ];
                const repeats = ['no-repeat', 'no-repeat'];
                const boxes = ['border-box', 'border-box'];
                let padding = '';

                if (ground) {
                    images.push(`url("${ground.url}")`);
                    if (hud.groundTile) {
                        padding = `padding:0 ${px(right.w) - 1}px 0 ${px(left.w) - 1}px;`;
                        positions.push('left bottom');
                        sizes.push(`${px(ground.w)}px ${px(ground.h)}px`);
                        repeats.push('repeat-x');
                        boxes.push('content-box');
                    } else {
                        const gap = px(left.w) + px(right.w) - 2;
                        positions.push(`${px(left.w) - 1}px bottom`);
                        sizes.push(`calc(100% - ${gap}px) ${px(ground.h)}px`);
                        repeats.push('no-repeat');
                        boxes.push('border-box');
                    }
                }

                const el = document.createElement('div');
                el.id = 'le-darkmode-hud-decor';
                el.className = 'col-start-1 row-start-1';
                el.style.cssText =
                    'grid-area:1 / 1;align-self:end;justify-self:stretch;pointer-events:none;' +
                    `height:${Math.max(px(left.h), px(right.h))}px;` +
                    `margin-bottom:${hud.bottom ?? 0}px;` +
                    padding +
                    `background-image:${images.join(',')};` +
                    `background-repeat:${repeats.join(',')};` +
                    `background-origin:${boxes.join(',')};` +
                    `background-clip:${boxes.join(',')};` +
                    `background-position:${positions.join(',')};` +
                    `background-size:${sizes.join(',')};`;

                return el;
            }

            function installHudDecor() {
                if (hudDecorTimer) {
                    clearInterval(hudDecorTimer);
                    hudDecorTimer = null;
                }

                document.getElementById('le-darkmode-hud-decor')?.remove();
                document.getElementById('le-darkmode-hud-decor-style')?.remove();

                const hud = THEME.hud;
                if (!hud) return;

                if (hud.hideBar) {
                    const style = document.createElement('style');
                    style.id = 'le-darkmode-hud-decor-style';
                    style.textContent = `
                         html .hud-footer .footer {
                             --bg-color: transparent !important;
                         }

                         html .hud-footer .footer > div[class*="bg-(--bg-color)"] {
                             background: transparent !important;
                             background-color: transparent !important;
                             box-shadow: none !important;
                             border-color: transparent !important;
                         }

                         html .hud-footer .footer > div > svg > path {
                             fill: transparent !important;
                         }
                     `;
                    document.head.appendChild(style);
                }

                if (!hud.assets) return;
                const decor = buildHudDecorElement(hud);

                const ensure = () => {
                    const footer = document.querySelector('.hud-footer .footer');
                    if (!footer || footer.contains(decor)) return;

                    const bar = footer.querySelector(
                        ':scope > div[class*="bg-(--bg-color)"]'
                    );
                    if (bar) bar.after(decor);
                    else footer.prepend(decor);
                };

                ensure();
                hudDecorTimer = setInterval(ensure, 1000);
            }

            /* ========================= OBSERVER ========================= */

            function handleButtonChange(target) {
                if (target.matches('.bb-base-button.variant--nav.theme--light')) {
                    styleNavButton(target);
                }
                if (target.matches('.bb-base-button.variant--neutral.theme--light')) {
                    styleNeutralButton(target);
                }
                if (target.matches('.bb-base-button.variant--normal.theme--light')) {
                    styleNormalButton(target);
                }
            }

            /* ========================= START ========================= */

            function startUIDarkmode() {
                applyRootTokens();
                installDarkmodeCSS();
                installHudDecor();
                installNavDecor();
                installCornerDecor();
                void installParticles();
                processUI(document.body);
                startMapBuildingDarkmode();

                const observer = new MutationObserver(mutations => {
                    ensureCornerDecorPlacement();

                    for (const mutation of mutations) {
                        if (mutation.type === 'attributes') {
                            const target = mutation.target;
                            if (!(target instanceof Element)) continue;

                            if (mutation.attributeName === 'src') {
                                replacePresetIcons(target);
                                continue;
                            }

                            if (mutation.attributeName === 'class') {
                                if (target.matches('.bb-amount-label')) {
                                    styleOrderPanels(target);
                                }
                                continue;
                            }

                            handleButtonChange(target);
                            styleOrderPanels(target);
                            continue;
                        }

                        if (mutation.type === 'characterData') {
                            const parent = mutation.target?.parentElement;
                            if (parent) styleOrderPanels(parent);
                            continue;
                        }

                        for (const node of mutation.addedNodes) {
                            if (node instanceof Element) {
                                processUI(node);
                            } else if (node.parentElement) {
                                styleOrderPanels(node.parentElement);
                            }
                        }
                    }
                });

                observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                    characterData: true,
                    attributes: true,
                    attributeFilter: [
                        'src',
                        'active',
                        'disabled',
                        'aria-label',
                        'class'
                    ]
                });

                requestAnimationFrame(() => {
                    applyRootTokens();
                    processUI(document.body);
                });

                console.log(
                    `[LE Manager - Darkmode] Preset "${THEME.label.de}" aktiv`
                );
            }

            if (document.readyState === 'loading') {
                document.addEventListener(
                    'DOMContentLoaded',
                    startUIDarkmode,
                    { once: true }
                );
            } else {
                startUIDarkmode();
            }

        }
    };

    async function registerDarkmodeModule() {
        if (!presetCache.index?.length) {
            await ensureIndexFresh();
        }
        if (root.LEM?.modules?.registerManaged) {
            root.LEM.modules.registerManaged(definition);
        } else {
            (root.__LEM_MODULE_QUEUE__ ||= []).push(definition);

            root.dispatchEvent(
                new CustomEvent('LEM:module-queued')
            );
        }
        moduleRegistered = true;
        void refreshPresetsInBackground(DEFAULT_PRESET);
        root.setInterval(() => {
            const id = root.LEM?.settings?.get?.(
                SETTING_PRESET,
                DEFAULT_PRESET
            ) ?? DEFAULT_PRESET;

            void refreshPresetsInBackground(id);
        }, PRESET_CACHE_MAX_AGE);
    }

    void registerDarkmodeModule();

    if (root.LEM?.settings) {
        setupFlightGame(root.LEM);
    } else {
        root.addEventListener('LEM:ready', () => {
            if (root.LEM?.settings) setupFlightGame(root.LEM);
        }, { once: true });
    }
})();