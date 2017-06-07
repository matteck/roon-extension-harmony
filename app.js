"use strict";

var debug                = require('debug')('roon-extension-harmony'),
    RoonApi              = require('node-roon-api'),
    RoonApiStatus        = require('node-roon-api-status'),
    RoonApiSettings      = require('node-roon-api-settings'),
    RoonApiSourceControl = require('node-roon-api-source-control'),
    Discover             = require('harmonyhubjs-discover'),
    Harmony              = require('harmonyhubjs-client');

const STATE_HUB_OFF           = 0;
const STATE_ACTIVITY_STARTING = 1;
const STATE_ACTIVITY_STARTED  = 2;
const STATE_HUB_TURNING_OFF   = 3;

/**
 * Creates a new HarmonyHub instance.
 *
 * @constructor
 */
function HarmonyHub(name, address) {
    this.name = name;
    this.address = address;
}

/**
 * Creates a Harmony client to talk to this HarmonyHub.
 */
HarmonyHub.prototype.createClient = function() {
    debug("HarmonyHub.createClient: Creating Harmony client for %s (%s)", this.name, this.address);

    var result = Harmony(this.address);
    return result.then((client) => {
        client._xmppClient.connection.socket.setTimeout(0);
        client._xmppClient.connection.socket.setKeepAlive(true, 10000);

        return result;
    });
}

HarmonyHub.prototype.toString = function() {
    return this.name;
}

/**
 * Creates a new HarmonyDiscovery intances. This class will keep track of all the Harmony hubs that are discovered on
 * the networks.
 *
 * @constructor
 */
function HarmonyDiscovery() {
    var self = this

    self.hubs = [];

    self._discover = new Discover(61991);
    self._discover.on('update', function (hubs) {
        debug('received update event from harmonyhubjs-discover. there are \'%d\' hubs: %O', hubs.length, hubs);

        self.hubs = hubs.map((entry) => { return new HarmonyHub(entry.friendlyName, entry.ip); });
    });

    self._discover.start();
}

var harmonyDiscovery = new HarmonyDiscovery();

var roon = new RoonApi({
    extension_id:        'org.pruessmann.roon.logitech.harmony',
    display_name:        'Logitech Harmony',
    display_version:     '0.0.1',
    publisher:           'Boris Prüßmann',
    email:               'boris@pruessmann.org',
    website:             'https://github.com/docbobo/roon-extension-harmony',
});

var harmony = {
    activities: {},
};

var mysettings = roon.load_config("settings") || {
        name: "",
        hostname: ""
};

function make_layout(settings) {
    var l = {
        values:    settings,
        layout:    [],
        has_error: false
    };

    l.layout.push({
        type:      "text",
        title:     "Please enter the hostname or IP address of the Harmony Hub."
    });

    l.layout.push({
       type:    "dropdown",
       title:   "Address",
       values:  harmonyDiscovery.hubs.map((entry) => { return { value: entry.address } }),
       setting: "hostname",
   });

    return l;
}

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        cb(make_layout(mysettings));
    },
    save_settings: function(req, isdryrun, settings) {
        let l = make_layout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if (!isdryrun && !l.has_error) {
            var old_hostname = mysettings.hostname;
            var old_name = mysettings.name;

            mysettings = l.values;
            mysettings.name = harmonyDiscovery.hubs.find((entry) => { return entry.address == mysettings.hostname }).name;

            svc_settings.update_settings(l);
            if (old_hostname != mysettings.hostname || old_name != mysettings.name) {
                setup_harmony_connection(new HarmonyHub(mysettings.name, mysettings.hostname));
                roon.save_config("settings", mysettings);
            }
        }
    }
});

var svc_status = new RoonApiStatus(roon);
var svc_source_control = new RoonApiSourceControl(roon);

roon.init_services({
    provided_services: [ svc_status, svc_settings, svc_source_control ]
});

function setup_harmony_connection(harmonyHub) {
    debug("setup_harmony_connection(%O)", harmonyHub);
    if (!harmonyHub.name || !harmonyHub.address) {
        svc_status.set_status("Not configured, please check settings.", true);
    } else {
        if (harmony.client) {
            harmony.client.then((harmonyClient) => { harmonyClient.end() });
            delete(harmony.client);
        }

        harmony.client = harmonyHub.createClient();
        harmony.client.then((harmonyClient) => {
            harmonyClient.getCurrentActivity().then((currentActivityId) => {
                debug("Retrieving Activities....");
                harmonyClient.getActivities().then((activities) => {
                    activities.forEach((activity) => {
                        if (activity.type === 'PowerOff') {
                            return;
                        }

                        if (harmony.activities[activity.id]) {
                            debug("Activity '%s' already registered as Source.", activity.id);
                            harmony.activities[activity.id].update_state({ status: currentActivityId == activity.id ? "selected" : "standby" });
                            return;
                        } else {
                            debug("Creating Source Control Service for '%s'", activity.label);
                            var device = {
                                state: {
                                    display_name:     activity.label,
                                    supports_standby: true,
                                    status:           currentActivityId == activity.id ? "selected" : "standby",
                                },
                                convenience_switch: function (req) {
                                    debug("convenience_switch (%s)", activity.id);

                                    harmonyClient.startActivity(activity.id).then(() => {
                                        debug("convenience_switch (%s) - Succeeded.", activity.id);

                                        req.send_complete("Success");
                                    }).catch((error) => {
                                        debug("convenience_switch (%s) - Failed.", activity.id);

                                        console.log(error);
                                        req.send_complete("Failure");
                                    });
                                },
                                standby: function (req) {
                                    debug("standby()");

                                    harmonyClient.turnOff().then(() => {
                                        debug("standby() - Succeeded.");

                                        req.send_complete("Success");
                                    }).catch((error) => {
                                        debug("standby() - Failed.");

                                        console.log(error);
                                        req.send_complete("Failure");
                                    });
                                }
                            };

                            harmony.activities[activity.id] = svc_source_control.new_device(device);
                        }
                    });

                    harmonyClient.keepalive = setInterval(() => {
                        harmonyClient.getCurrentActivity().then((val) => {
                            debug("Keep-Alive: getCurrentActivity() == %s", val);
                        });
                    }, 10000);

                    harmonyClient._xmppClient.on('offline', () => {
                        debug("Harmony Hub went offline...");
                        setup_harmony_connection(harmonyHub);
                    });

                    harmonyClient.on('stateDigest', (val) => {
                        debug("stateDigest: state for '%s' => %s", val.activityId,  val.activityStatus);
                        for (var key in harmony.activities) {
                            if (key == val.activityId) {
                                switch (val.activityStatus) {
                                    case STATE_ACTIVITY_STARTING:
                                    case STATE_ACTIVITY_STARTED:
                                        harmony.activities[key].update_state({ status: "selected" });
                                        break;

                                    case STATE_HUB_OFF:
                                        harmony.activities[key].update_state({ status: "standby" });
                                        break;

                                    default:
                                        // Ignoring
                                        break;
                                }
                            } else {
                                switch (val.activityStatus) {
                                    case STATE_ACTIVITY_STARTED:
                                        harmony.activities[key].update_state({ status: "standby" });
                                        break;

                                    case STATE_HUB_OFF:
                                        harmony.activities[key].update_state({ status: "standby" });
                                        break;

                                    default:
                                        // Ignoring
                                        break;
                                }
                            }
                        }
                    });

                    svc_status.set_status("Connected to Harmony Hub " + harmonyHub.name, false);
                });
            });
        }).catch((error) => {
            debug("setup_harmony_connection: Error during setup. Retrying...")

            console.log(error);
            setup_harmony_connection(harmonyHub);
        });
    }
}

setup_harmony_connection(new HarmonyHub(mysettings.name, mysettings.hostname));

roon.start_discovery();
