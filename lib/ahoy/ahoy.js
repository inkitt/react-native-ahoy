import { NetInfo } from 'react-native';
import { isFunction } from 'lodash';
import queueFactory from 'react-native-queue';

import { generateUUID } from '../utils';
import { trackPost } from '../api';

/*

INPUT PARAMETERS:
{
  visitorId: string - visitor id
  visitData: object - extra visit data to be sent to ahoy server
  onTracking: {
    started:   async (event)           - function that will be invoked after tracking start
    succeeded: async (event)           - function that will be invoked when tracking success
    failure:   async (event)           - function that will be invoked when tracking failure (before failed)
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

  offlineMode: boolean - ONLY FOR TESTING PURPOSES, indicates if you want to test with no internet
}

*/

const JOB_VISITOR = 'visitor';
const JOB_TRACKING = 'tracking';
const WORKERS_OPTIONS = {
  timeout: 3000,
  attempts: 1000,
  concurrency: 1,
};

const onTrackingEvents = ['started', 'succeeded', 'failure', 'failed', 'error'];
const trackEvents = ['event', 'visit'];

export default class Ahoy {
  constructor({
    visitorId,
    visitParams,
    onTracking,
    trackPosts,
    trackUrls,
    offlineMode,
  }) {
    this.visitId = generateUUID();
    this.visitorId = visitorId;
    this.visitParams = visitParams || {};
    this.onTracking = onTracking || null;
    this.trackPosts = trackPosts || null;
    this.trackUrls = trackUrls || null;
    this.offlineMode = offlineMode || false;
  }

  init = async () => {
    await this.initConnection();
    await this.initQueue();
    // this.visitId = generateUUID();

    const data = {
      visit: {
        id: this.visitId,
        visitor_id: this.visitorId,
        ...this.visitParams,
      },
    };

    this.createJob(JOB_VISITOR, data);
  }

  initConnection = async () => {
    this.hasInternetAccess = await NetInfo.isConnected.fetch();
    NetInfo.isConnected.addEventListener('connectionChange', this.handleNetInfoConnectionChange);
  }

  initQueue = async () => {
    this.queue = await queueFactory(true);
    this.addTrackingWorker();
    this.addVisitorWorker();
  }

  trackEvent = async (_event) => {
    const event = Object.assign({}, _event);
    if (event.time) event.timestamp = event.time;

    const trackEvent = {
      event: {
        ...event,
      },
    };

    return this.trackInvoke('event', trackEvent);
  }

  trackVisit = async event => this.trackInvoke('visit', event);

  /**
   * Send event to jobs queue
   * @param name
   * @param properties
   * @returns {Promise<{name: *, id: *, visit_id: *, properties: *, timestamp: number}>}
   */
  track = async (name, properties = {}) => {
    const event = {
      id: generateUUID(),
      visit_id: this.visitId,
      timestamp: new Date().getTime() / 1000.0,
      name,
      properties: this.prepareProperties(properties),
    };
    this.createJob(JOB_TRACKING, event);
    return event;
  };

  createJob = (name, event) => {
    if (this.offlineMode) this.hasInternetAccess = undefined;

    if (this.queue) this.queue.createJob(name, event);
  };

  // =====================
  // + HELP METHODS
  // =====================
  /**
   * Prepare properties object for ahoy
   * @param inter
   */
  prepareProperties = (inter) => {
    const properties = {};
    Object.keys(inter).map((name, key) => {
      let k = name.replace(/[^a-z0-9_]/gi, '');
      properties[k] = inter[name];
    });
    return properties;
  }
  onTrackingInvoke = async (call, params) => {
    if (!this.onTracking) {
      throw new Error('Please, specify onTracking');
    }

    if (!onTrackingEvents.includes(call)) {
      throw new Error(`onTracking[${call}] is not a function`);
    }

    if (!isFunction(this.onTracking[call])) {
      throw new Error(`onTracking[${call}] is not a function`);
    }

    return this.onTracking[call](params);
  }

  trackInvoke = async (call, params) => {
    if (!(this.trackUrls || this.trackPosts)) {
      throw new Error('Please, specify trackUrls or trackPosts');
    }

    if (!trackEvents.includes(call)) {
      throw new Error(`Please, make sure that '${call}' is in [${trackEvents}]`);
    }

    if (!this.trackPosts) {
      return trackPost(this.trackUrls[call], params);
    }

    if (!isFunction(this.trackPosts[call])) {
      throw new Error(`trackPosts[${call}] is not a function`);
    }

    return this.trackPosts[call](params);
  }

  handleNetInfoConnectionChange = (isConnected) => {
    this.hasInternetAccess = isConnected;
  };

  // =====================
  // - HELP METHODS
  // =====================


  // =====================
  // + WORKERS
  // =====================

  addTrackingWorker = () => {
    this.queue.addWorker(
      JOB_TRACKING,
      async (id, event) => {
        await this.onTrackingInvoke('started', event);

        if (!this.hasInternetAccess) {
          throw new Error('No internet connection for request from queue');
        }

        this.trackEvent(event)
          .then()
          .catch((err) => { throw new Error(err); });
      },
      {
        onSuccess: async (id, event) => { await this.onTrackingInvoke('succeeded', event); },
        onFailure: async (id, event) => { await this.onTrackingInvoke('failure', event); },
        onFailed: async (id, event) => { await this.onTrackingInvoke('failed', event); },
        ...WORKERS_OPTIONS,
      },
    );
  };

  addVisitorWorker = () => {
    this.queue.addWorker(
      JOB_VISITOR,
      async (id, event) => {
        await this.onTrackingInvoke('started', event);

        if (!this.hasInternetAccess) {
          await this.onTrackingInvoke('error', event);
          throw new Error('No internet connection for request from queue');
        }

        this.trackVisit(event)
          .then()
          .catch((err) => { throw new Error(err); });
      },
      {
        onSuccess: async (id, event) => { await this.onTrackingInvoke('succeeded', event); },
        onFailure: async (id, event) => { await this.onTrackingInvoke('failure', event); },
        onFailed: async (id, event) => { await this.onTrackingInvoke('failed', event); },
        ...WORKERS_OPTIONS,
      },
    );
  };

  // =====================
  // - WORKERS
  // =====================
}
