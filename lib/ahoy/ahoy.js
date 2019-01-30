import { NetInfo } from 'react-native';
import { uniqBy, transform, isFunction } from 'lodash';
import queueFactory from 'react-native-queue';

import { generateUUID, sleep } from '../utils';
import { trackPost } from '../api';
import storage, { KEYS } from '../storage';

/*

INPUT PARAMETERS:
{
  visitorId: string - visitor id
  visitData: object - extra visit data to be sent to ahoy server
  onTracking: {
    started:   async (event)           - function that will be invoked after tracking start
    succeeded: async (event)           - function that will be invoked when tracking success
    failed:    async (event)           - function that will be invoked if tracking fails
    error:     async ({ name, error }) - function that will be invoked when error occured
  }

  // will be chosen one: trackPosts or trackUrls.
  // if not presented just skip it or should be equal null
  // if two presented, trackPosts will have more priority
  trackPosts: {
    event: async (params) - function that will be invoked when track an event. Individual implementation
    visit: async (params) - function that will be invoked when track a visit.  Individual implementation
  }
  trackUrls: {
    event: string - url for event where request should be sent to
    visit: string - url for visit where request should be sent to
  }
}

*/

const onTrackingEvents = ['started', 'succeeded', 'failed', 'error'];
const trackEvents = ['event', 'visit'];

export default class Ahoy {
  constructor({
    visitorId,
    visitParams,
    onTracking,
    trackPosts,
    trackUrls,
  }) {
    this.visitId = null;
    this.visitorId = visitorId;
    this.visitParams = visitParams || {};
    this.onTracking = onTracking || null;
    this.trackPosts = trackPosts || null;
    this.trackUrls = trackUrls || null;

    this.eventQueue = [];
    this.trackedEvents = [];

    this.initialized = false;

    this.sendedTracking = false;
    this.hasInternetAccess = false;
    NetInfo.isConnected.addEventListener('connectionChange', this.handleNetInfoConnectionChange);
  }

  init = async () => {
    await this.getQueue();
    this.visitId = generateUUID();

    const data = {
      visit: {
        id: this.visitId,
        visitor_id: this.visitorId,
        ...this.visitParams,
      },
    };

    this.getQueue().then(() => {
      this.queue.createJob('visitor', data);
    });

    let eventQueue = [];
    try {
      eventQueue = await this.loadEventQueue();
      this.eventQueue = uniqBy([...eventQueue, ...this.eventQueue], 'id');
    } catch (err) {
      console.log(err);
    }

    this.initialized = true;
    if (eventQueue.length > 0) {
      this.sendTrackingInterval();
    }
  }

  getQueue = async () => {
    if (this.queue) {
      return this.queue;
    }

    this.queue = await queueFactory();
    this.addTrackingWorker();
    this.addVisitorWorker();

    return this.queue;
  }

  saveEventQueue = async () => {
    await storage.write(KEYS.events, JSON.stringify(this.eventQueue));
  }

  loadEventQueue = async () => {
    const eventData = await storage.read(KEYS.events);
    const eventQueue = eventData ? JSON.parse(eventData) : [];

    return eventQueue;
  }

  sendTrackingInterval = async () => {
    if (!this.initialized && this.sendedTracking) return;

    this.sendsTracking = true;

    try {
      if (this.hasInternetAccess && this.eventQueue.length > 0) {
        const event = this.eventQueue.shift();

        if (this.eventQueue.find(el => el.id === event.id)) {
          await this.onTrackingInvoke('error', {
            name: this.eventQueue.find(el => el.id === event.id),
            error: 'Error Duplicate in tracking in eventQueue',
          });
        }

        if (this.trackedEvents.find(el => el.id === event.id)) {
          await this.onTrackingInvoke('error', {
            name: this.trackedEvents.find(el => el.id === event.id),
            error: 'Error Duplicate in tracking in trackedEvents',
          });
        }

        await this.trackEvent(event);

        this.trackedEvents.push(event);
        await this.saveEventQueue();
      }
    } catch (e) {
      await this.onTrackingInvoke('error', {
        name: e,
        error: 'Error when try send tracking to ahoy',
      });
    }

    this.sendsTracking = false;
    this.startInterval();
  }

  trackEvent = async (event) => {
    if (event.time) event.timestamp = event.time;

    const trackEvent = {
      event: {
        ...event,
        visit_id: this.visitId,
      },
    };

    await this.trackInvoke('event', trackEvent);
  }

  track = (name, properties) => {
    const event = {
      id: generateUUID(),
      timestamp: new Date().getTime() / 1000.0,
      name,
      properties: transform(properties, (result, val, key) => (result[key.replace(/[^a-z0-9]/gi, '')] = val)),
    };

    this.getQueue().then(() => {
      this.queue.createJob('tracking', event);
    });

    return event;
  };

  // =====================
  // + WORKERS
  // =====================

  addTrackingWorker = () => {
    this.queue.addWorker(
      'tracking',
      async (id, event) => {
        await this.onTrackingInvoke('started', event);

        if (!this.visitId && !this.hasInternetAccess) {
          await sleep(4000);
        }

        await new Promise((resolve) => {
          this.trackEvent(event).then(() => {
            resolve();
          });
        });
      },
      {
        onSuccess: async (id, event) => {
          this.trackedEvents.push(event);

          await this.onTrackingInvoke('succeeded', event);
        },
        onFailure: async (id, event) => {},
        onFailed: async (id, event) => {
          if (!this.hasInternetAccess) {
            if (this.queue) this.queue.createJob('tracking', event);
            return;
          }

          await this.onTrackingInvoke('failed', event);
        },
        timeout: 3000,
        attempts: 1000,
        concurrency: 2,
      },
    );
  };

  addVisitorWorker = () => {
    this.queue.addWorker(
      'visitor',
      async (id, event) => {
        await this.onTrackingInvoke('started', event);

        if (!this.visitId && !this.hasInternetAccess) {
          await sleep(4000);
        }

        await new Promise((resolve) => {
          this.trackInvoke('visit', event).then((res) => {
            resolve();
          });
        });
      },
      {
        onSuccess: async (id, event) => {
          this.trackedEvents.push({ ...event, name: '$visit' });

          await this.onTrackingInvoke('succeeded', event);
        },
        onFailure: async (id, event) => {},
        onFailed: async (id, event) => {
          if (!this.hasInternetAccess) {
            if (this.queue) this.queue.createJob('visitor', event);
            return;
          }

          await this.onTrackingInvoke('failed', event);
        },
        timeout: 3000,
        attempts: 1000,
        concurrency: 2,
      },
    );
  };

  // =====================
  // - WORKERS
  // =====================

  onTrackingInvoke = async (call, params) => {
    if (this.onTracking && onTrackingEvents.includes(call)) {
      if (isFunction(this.onTracking[call])) {
        await this.onTracking[call](params);
      } else {
        console.error(`onTracking[${call}] is not a function`);
      }
    }
  }

  trackInvoke = async (call, params) => {
    if (this.trackUrls || this.trackPosts) {
      if (trackEvents.includes(call)) {
        if (this.trackPosts) {
          if (isFunction(this.trackPosts[call])) {
            await this.trackPosts[call](params);
          } else {
            console.error(`trackPosts[${call}] is not a function`);
          }
        } else { // this.trackUrls !== null
          await trackPost(this.trackUrls[call], params);
        }
      }
    } else {
      console.error('Please, specify trackUrls or trackPosts');
    }
  }

  startInterval = () => {
    this.timeout = setTimeout(() => {
      this.sendTrackingInterval();
    }, this.hasInternetAccess ? 500 : 3000);
  };

  handleNetInfoConnectionChange = async (isConnected) => {
    if (isConnected) {
      this.hasInternetAccess = true;
      return;
    }
    this.hasInternetAccess = false;
  };
}
