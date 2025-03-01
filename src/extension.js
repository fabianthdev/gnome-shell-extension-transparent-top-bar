const {Meta, St} = imports.gi;

const Main = imports.ui.main;
const GLib = imports.gi.GLib;

const Config = imports.misc.config;
const [major] = Config.PACKAGE_VERSION.split('.');
const shellVersion = Number.parseInt(major);

const ExtensionUtils = imports.misc.extensionUtils;

/**
 * https://developer.mozilla.org/docs/Web/API/WindowOrWorkerGlobalScope/setTimeout
 * https://developer.mozilla.org/docs/Web/API/WindowOrWorkerGlobalScope/clearTimeout
 */
window.setTimeout = function(func, delay, ...args) {
    return GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        func(...args);
        return GLib.SOURCE_REMOVE;
    });
};

window.clearTimeout = GLib.source_remove;

class Extension {
    constructor() {
        this._actorSignalIds = null;
        this._windowSignalIds = null;
        this.transparencyChangeDebounce = null;
        this.darkFullScreenChangeDebounce = null;
    }

    enable() {
        this._settings = ExtensionUtils.getSettings('com.ftpix.transparentbar');
        this._currentTransparency = this._settings.get_int('transparency');
        this._darkFullScreen = shellVersion >= 40 ? this._settings.get_boolean('dark-full-screen') : true;

        this._actorSignalIds = new Map();
        this._windowSignalIds = new Map();
        this._settings.connect('changed', this.transparencyChanged.bind(this));
        this._actorSignalIds.set(Main.overview, [
            Main.overview.connect('showing', this._updateTransparent.bind(this)),
            Main.overview.connect('hiding', this._updateTransparent.bind(this))
        ]);

        this._actorSignalIds.set(Main.sessionMode, [
            Main.sessionMode.connect('updated', this._updateTransparent.bind(this))
        ]);

        for (const metaWindowActor of global.get_window_actors()) {
            this._onWindowActorAdded(metaWindowActor.get_parent(), metaWindowActor);
        }

        this._actorSignalIds.set(global.window_group, [
            global.window_group.connect('actor-added', this._onWindowActorAdded.bind(this)),
            global.window_group.connect('actor-removed', this._onWindowActorRemoved.bind(this))
        ]);

        this._actorSignalIds.set(global.window_manager, [
            global.window_manager.connect('switch-workspace', this._updateTransparent.bind(this))
        ]);

        this._updateTransparent();
    }

    transparencyChanged(settings, key) {
        if (key === 'transparency') {
            clearTimeout(this.settingChangeDebounce);
            this.settingChangeDebounce = setTimeout(() => {
                const oldTransparency = this._currentTransparency;
                this._currentTransparency = this._settings.get_int('transparency');
                Main.panel.remove_style_class_name('transparent-top-bar--transparent-' + oldTransparency);
                this._updateTransparent();
            }, 250);
            return;
        }

        if(key === 'dark-full-screen'){
            this._darkFullScreen = shellVersion >= 40 ? this._settings.get_boolean('dark-full-screen') : true;
            clearTimeout(this.darkFullScreenChangeDebounce);
            this.darkFullScreenChangeDebounce = setTimeout(() => {
                Main.panel.remove_style_class_name('transparent-top-bar--transparent-' + this._currentTransparency);
                this._updateTransparent();
            }, 250);
            return;
        }
    }

    disable() {
        for (const actorSignalIds of [this._actorSignalIds, this._windowSignalIds]) {
            for (const [actor, signalIds] of actorSignalIds) {
                for (const signalId of signalIds) {
                    actor.disconnect(signalId);
                }
            }
        }
        this._actorSignalIds = null;
        this._windowSignalIds = null;

        this._setAllTransparent(false);
        this._settings = null;
    }

    _onWindowActorAdded(container, metaWindowActor) {
        this._windowSignalIds.set(metaWindowActor, [
            metaWindowActor.connect('notify::allocation', this._updateTransparent.bind(this)),
            metaWindowActor.connect('notify::visible', this._updateTransparent.bind(this))
        ]);
    }

    _onWindowActorRemoved(container, metaWindowActor) {
        for (const signalId of this._windowSignalIds.get(metaWindowActor)) {
            metaWindowActor.disconnect(signalId);
        }
        this._windowSignalIds.delete(metaWindowActor);
        this._updateTransparent();
    }

    _updateTransparent() {
        if(!this._darkFullScreen){
            this._setAllTransparent(true);
            return
        }

        if (Main.panel.has_style_pseudo_class('overview') || !Main.sessionMode.hasWindows) {
            this._setAllTransparent(true);
            return;
        }

        if (!Main.layoutManager.primaryMonitor) {
            return;
        }

        // Get all the windows in the active workspace that are in the primary monitor and visible.
        const workspaceManager = global.workspace_manager;
        const activeWorkspace = workspaceManager.get_active_workspace();

        const windows = activeWorkspace.list_windows().filter(metaWindow => {
            return  metaWindow.showing_on_its_workspace()
                && !metaWindow.is_hidden()
                && metaWindow.get_window_type() !== Meta.WindowType.DESKTOP
                && (!Meta.is_wayland_compositor() || !metaWindow.skip_taskbar);
        })

        var monitors = {};
        windows.forEach(window => {
            if (monitors[window.get_monitor()]) {
                monitors[window.get_monitor()].push(window)
            } else {
                monitors[window.get_monitor()] = [window];
            }
        });

        Main.layoutManager.monitors.forEach(monitor => {
            const panel = (() => {
                if (monitor.index == Main.layoutManager.primaryMonitor.index) {
                    return Main.panel;
                } else if (Main.mmPanel) {
                    return Main.mmPanel[monitor.index - 1];
                }
                return null;
            })();

            if (!panel) {
                return;
            }

            const monitor_windows = monitors[monitor.index];
            if (monitor_windows) {
                const panelTop = panel.get_transformed_position()[1];
                const panelBottom = panelTop + panel.get_height();
                const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                const isNearEnough = monitor_windows.some(metaWindow => {
                    const verticalPosition = metaWindow.get_frame_rect().y;
                    return verticalPosition < panelBottom + 5 * scale;
                });

                this._setTransparent(!isNearEnough, panel);
            } else {
                this._setTransparent(true, panel);
            }
        });
    }

    _setTransparent(transparent, panel) {
        const transparency = this._settings.get_int("transparency");

        if (transparent) {
            panel.remove_style_class_name('transparent-top-bar--solid');
            panel.add_style_class_name('transparent-top-bar--transparent');
            panel.add_style_class_name('transparent-top-bar--transparent-' + transparency);
        } else {
            panel.add_style_class_name('transparent-top-bar--solid');
            panel.remove_style_class_name('transparent-top-bar--transparent');
            panel.remove_style_class_name('transparent-top-bar--transparent-' + transparency);
        }
    }

    _setAllTransparent(transparent) {
        const transparency = this._settings.get_int("transparency");
        var panels = [Main.panel];
        if (Main.mmPanel) {
            panels = panels.concat(Main.mmPanel);
        }

        if (transparent) {
            panels.forEach(panel => {
                panel.remove_style_class_name('transparent-top-bar--solid');
                panel.add_style_class_name('transparent-top-bar--transparent');
                panel.add_style_class_name('transparent-top-bar--transparent-' + transparency);
            })

        } else {
            panels.forEach(panel => {
                panel.add_style_class_name('transparent-top-bar--solid');
                panel.remove_style_class_name('transparent-top-bar--transparent');
                panel.remove_style_class_name('transparent-top-bar--transparent-' + transparency);
            })
        }
    }
};

function init() {
    return new Extension();
}