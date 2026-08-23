/* main.js — bootstrap: wires everything on DOMContentLoaded */

document.addEventListener('DOMContentLoaded', () => {
    /* App.bootReady resolves when the full boot (incl. tab restore) is done.
       User-triggered note ops (createNewNote, openNoteInTab) await it so a
       click landing mid-boot can't race the tab-restore chain. */
    App.bootReady = (async () => {
        initTheme();
        initTabs();
        initContextMenu();
        initTrash();
        initNewNoteMenu();
        initNoteMenu();
        initNavigation();

        /* Launcher rail — every visible icon is a real destination */
        const searchBtn = document.getElementById('launcherSearch');
        if (searchBtn) searchBtn.addEventListener('click', openQuickSearch);
        const calBtn = document.getElementById('launcherCalendar');
        if (calBtn) calBtn.addEventListener('click', toggleCalendar);

        /* Status bar: clicking a failed save state retries the save.
           Wired here (not in initEditor) so it works even if the editor
           library fails to load — it is shell chrome, not editor internals. */
        const statusLeft = document.getElementById('status-left');
        if (statusLeft) {
            statusLeft.addEventListener('click', () => {
                if (statusLeft.classList.contains('st-error') && typeof saveNoteNow === 'function') saveNoteNow();
            });
        }

        /* Resizable panes */
        if (typeof Split !== 'undefined') {
            Split(['#left-pane', '#main-pane'], {
                sizes: [22, 78],
                minSize: [200, 300],
                gutterSize: 6,
                cursor: 'col-resize',
            });
        }

        initTree();
        initEditor();
        initSearch();
        initBookmarks();
        initTableView();
        initFiles();
        if (typeof initChatMiniToolbar === 'function') initChatMiniToolbar();

        /* Launcher: Calendar opens the month-view panel (events + day notes) */
        const closeCal = document.getElementById('closeCalendarBtn');
        if (closeCal) closeCal.addEventListener('click', toggleCalendar);
        const calOverlay = document.getElementById('calendarOverlay');
        if (calOverlay) {
            calOverlay.addEventListener('click', function (e) {
                if (e.target === this) toggleCalendar();
            });
        }

        /* Launcher icon active state */
        const icons = document.querySelectorAll('.launcher .ic');
        icons.forEach((ic) => {
            ic.addEventListener('click', function () {
                icons.forEach((i) => i.classList.remove('active'));
                this.classList.add('active');
            });
        });

        /* Restore persisted tabs last — needs editor + tree ready */
        await loadPersistedTabs();
        App.bootDone = true; // E2E specs wait on this instead of sleeping
    })();
});
