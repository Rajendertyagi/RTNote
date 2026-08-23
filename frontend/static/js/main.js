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
        const calBtn = document.getElementById('launcherCalendar');
        if (calBtn) calBtn.addEventListener('click', toggleCalendar);
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
