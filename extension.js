
const { Clutter, GLib, GObject, Graphene, Meta, St } = imports.gi;

const Background = imports.ui.background;
const Main = imports.ui.main;
const Overview = imports.ui.overview;
const OverviewControls = imports.ui.overviewControls;
const Util = imports.misc.util;
const Workspace = imports.ui.workspace;

var bgManagers = [];
var savedWorkspaceProto, savedControlsProto;

function enable() {
	// Add static background
	for (var monitor of Main.layoutManager.monitors) {
		let bgManager = new Background.BackgroundManager({
			monitorIndex: monitor.index,
			container: Main.layoutManager.overviewGroup,
			vignette: true,
		});

		bgManagers.push(bgManager);
		
		bgManager._fadeSignal = Main.overview._overview
			._controls
			._stateAdjustment
			.connect('notify::value', (v) => {
				bgManager.backgroundActor.content.vignette_sharpness = Util.lerp(0, 0.6, Math.min(v.value, 1));
				bgManager.backgroundActor.content.brightness = Util.lerp(1, 0.75, Math.min(v.value, 1));
			});
	}

	// Remove scaling background
	savedWorkspaceProto = overrideProto(Workspace.Workspace.prototype, WorkspaceOverride);

	// Add animations
	savedControlsProto = overrideProto(OverviewControls.ControlsManager.prototype, ControlsOverride)
}

function disable() {
	for (const mgr of bgManagers) {
		Main.overview._overview._controls._stateAdjustment.disconnect(mgr._fadeSignal);
		mgr.destroy();
	}
	bgManagers = [];

	overrideProto(OverviewControls.ControlsManager.prototype, savedControlsProto);
	overrideProto(Workspace.Workspace.prototype, savedWorkspaceProto);
}

function animateOpenOverview() {
	const controls = Main.overview._overview._controls;

	// Animate dash
	if (isDashToDock()) {
		controls.dash.translation_y = 0;
	} else {
		controls.dash.translation_y = controls.dash.height;
		controls.dash.ease({ translation_y: 0, duration: Overview.ANIMATION_TIME });
	}
	
	// Animate search
	controls._searchEntry.opacity = 0;
	controls._searchEntry.ease({ opacity: 255, duration: Overview.ANIMATION_TIME })

	// Animate workspace switcher
	controls._thumbnailsBox._indicator.opacity = 0;
	controls._thumbnailsBox._indicator.ease({ opacity: 255, duration: Overview.ANIMATION_TIME })
	controls._thumbnailsBox._thumbnails.forEach(thumbnail => {
		thumbnail.opacity = 0;
		thumbnail.ease({ opacity: 255, duration: Overview.ANIMATION_TIME });
	})
}

function animateCloseOverview() {
	const controls = Main.overview._overview._controls;

	// Animate dash
	if (isDashToDock()) {
		controls.dash.translation_y = 0;
	} else {
		controls.dash.ease({ translation_y: controls.dash.height, duration: Overview.ANIMATION_TIME });
	}

	// Animate search
	controls._searchEntry.ease({ opacity: 0, duration: Overview.ANIMATION_TIME })

	// Animate workspace switcher
	controls._thumbnailsBox._indicator.ease({ opacity: 0, duration: Overview.ANIMATION_TIME })
	controls._thumbnailsBox._thumbnails.forEach(thumbnail => {
		thumbnail.ease({ opacity: 0, duration: Overview.ANIMATION_TIME });
	})
}

// Hack to detect if Dash to Dock or a fork thereof is enabled
function isDashToDock() {
	global.log("indash", Object.keys(Main.overview.dash));
	return '_position' in Main.overview.dash;
}

function overrideProto(proto, overrides) {
	const backup = {};

	for (var symbol in overrides) {
		if (symbol.startsWith('after_')) {
			const actualSymbol = symbol.substr('after_'.length);
			const fn = proto[actualSymbol];
			const afterFn = overrides[symbol]
			proto[actualSymbol] = function() {
				const args = Array.prototype.slice.call(arguments);
				const res = fn.apply(this, args);
				afterFn.apply(this, args);
				return res;
			};
			backup[actualSymbol] = fn;
		} else {
			backup[symbol] = proto[symbol];
			if (symbol.startsWith('vfunc')) {
				hookVfunc(proto, symbol.substr(6), overrides[symbol]);
			} else {
				proto[symbol] = overrides[symbol];
			}
		}
	}
	return backup;
}

WorkspaceOverride = {
	_init: function (metaWorkspace, monitorIndex, overviewAdjustment) {
		St.Widget.prototype._init.call(this, {
			style_class: 'window-picker',
			pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
			layout_manager: new Clutter.BinLayout(),
		});

		const layoutManager = new Workspace.WorkspaceLayout(metaWorkspace, monitorIndex,
			overviewAdjustment);

		// Window previews
		this._container = new Clutter.Actor({
			reactive: true,
			x_expand: true,
			y_expand: true,
		});
		this._container.layout_manager = layoutManager;
		this.add_child(this._container);

		this.metaWorkspace = metaWorkspace;
		this._activeWorkspaceChangedId =
			this.metaWorkspace?.connect('notify::active', () => {
				layoutManager.syncOverlays();
			});

		this._overviewAdjustment = overviewAdjustment;

		this.monitorIndex = monitorIndex;
		this._monitor = Main.layoutManager.monitors[this.monitorIndex];

		if (monitorIndex != Main.layoutManager.primaryIndex)
			this.add_style_class_name('external-monitor');

		const clickAction = new Clutter.ClickAction();
		clickAction.connect('clicked', action => {
			// Switch to the workspace when not the active one, leave the
			// overview otherwise.
			if (action.get_button() === 1 || action.get_button() === 0) {
				const leaveOverview = this._shouldLeaveOverview();

				this.metaWorkspace?.activate(global.get_current_time());
				if (leaveOverview)
					Main.overview.hide();
			}
		});
		this.bind_property('mapped', clickAction, 'enabled', GObject.BindingFlags.SYNC_CREATE);
		this._container.add_action(clickAction);

		this.connect('style-changed', this._onStyleChanged.bind(this));
		this.connect('destroy', this._onDestroy.bind(this));

		this._skipTaskbarSignals = new Map();

		const windows = global.get_window_actors().map(a => a.meta_window)
			.filter(this._isMyWindow, this);

		// Create clones for windows that should be
		// visible in the Overview
		this._windows = [];
		for (let i = 0; i < windows.length; i++) {
			if (this._isOverviewWindow(windows[i]))
				this._addWindowClone(windows[i]);
		}

		// Track window changes, but let the window tracker process them first
		if (this.metaWorkspace) {
			this._windowAddedId = this.metaWorkspace.connect_after(
				'window-added', this._windowAdded.bind(this));
			this._windowRemovedId = this.metaWorkspace.connect_after(
				'window-removed', this._windowRemoved.bind(this));
		}
		this._windowEnteredMonitorId = global.display.connect_after(
			'window-entered-monitor', this._windowEnteredMonitor.bind(this));
		this._windowLeftMonitorId = global.display.connect_after(
			'window-left-monitor', this._windowLeftMonitor.bind(this));
		this._layoutFrozenId = 0;

		// DND requires this to be set
		this._delegate = this;
	},
}

ControlsOverride = {
	animateToOverview() {
		animateOpenOverview();
		savedControlsProto.animateToOverview.call(this, ...arguments);
	},
	animateFromOverview() {
		savedControlsProto.animateFromOverview.call(this, ...arguments);
		animateCloseOverview();
	},
}
