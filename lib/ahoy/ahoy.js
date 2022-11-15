import NetInfo from '@react-native-community/netinfo';
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
  timeout: 20000,
  attempts: 1000,
  concurrency: 1,
};

const onTrackingEvents = ['started', 'succeeded', 'failure', 'failed', 'error'];
const trackEvents = ['event', 'visit'];

export default class Ahoy {
  constructor({
    visitorId,
    userId,
    visitParams,
    onTracking,
    trackPosts,
    trackUrls,
    offlineMode,
    visitId,
    applicationBundleId,
    isTrackVisit = true,
  }) {
    this.visitId = visitId;
    this.visitorId = visitorId;
    this.userId = userId;
    this.visitParams = visitParams || {};
    this.onTracking = onTracking || null;
    this.trackPosts = trackPosts || null;
    this.trackUrls = trackUrls || null;
    this.offlineMode = offlineMode || false;
    this.applicationBundleId = applicationBundleId || '';
    this.isTrackVisit = isTrackVisit;
  }

  init = async () => {
    await this.initConnection();
    await this.initQueue();
    // this.visitId = generateUUID();

    const data = {
      visit: {
        id: this.visitId,
        visitor_id: this.visitorId,
        user_id: this.userId,
        ...this.visitParams,
      },
    };

    this.createJob(JOB_VISITOR, data);
  }

  setVisitId = (visitId: string): void => {
    this.visitId = visitId;

    if (this.hasInternetAccess && this.isTrackVisit) {
      this.trackVisit({
        visit: {
          id: this.visitId,
          visitor_id: this.visitorId,
          user_id: this.userId,
          ...this.visitParams,
        },
      });
    }
  }

  initConnection = async () => {
    const state = await NetInfo.fetch();
    this.hasInternetAccess = state.isConnected;
    NetInfo.addEventListener(this.handleNetInfoConnectionChange);
  }

  initQueue = async () => {
    this.queue = await queueFactory(true);
    this.addTrackingWorker();
    if (this.isTrackVisit) {
      this.addVisitorWorker();
    }
  }

  trackEvent = async (_event) => {
    const event = Object.assign({}, _event);

    if (event.time) {
      event.timestamp = event.time;
    }

    const trackEvent = {
      event: {
        ...event,
        applicationBundleId: this.applicationBundleId,
      },
    };

    return this.trackInvoke('event', trackEvent);
  }

  trackVisit = event => this.trackInvoke('visit', event);

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
      user_id: this.userId,
      _visitor_id: this.visitorId,
      _user_id: this.userId,
      timestamp: new Date().getTime() / 1000.0,
      name,
      properties: this.prepareProperties(properties),
    };
    // Send event to all services before ahoy queue
    await this.onTrackingInvoke('started', event);
    // Create ahoy job and add to queue
    this.createJob(JOB_TRACKING, event);
    return event;
  };

  createJob = (name, event) => {
    if (this.offlineMode) {
      this.hasInternetAccess = undefined;
    }

    if (this.queue) {
      this.queue.createJob(name, event);
    }
  };

  handleNetInfoConnectionChange = (state) => {
    this.hasInternetAccess = state.isConnected;
  };

  // =====================
  // + HELP METHODS
  // =====================
  /**
   * Prepare properties object for ahoy
   * @param inter
   */
  prepareProperties = (inter) => {
    const properties = {
      applicationBundleId: this.applicationBundleId,
    };
    Object.keys(inter).map((name, key) => {
      const k = name.replace(/[^a-z0-9_]/gi, '');
      const val = inter[name];
      properties[k] = (typeof val === 'boolean') ? val.toString() : val;
    });
    return properties;
  }

  onTrackingInvoke = async (call, params, error) => {
    if (!this.onTracking) {
      throw new Error('Please, specify onTracking');
    }

    if (!onTrackingEvents.includes(call)) {
      throw new Error(`onTracking[${call}] is not a function`);
    }

    if (!isFunction(this.onTracking[call])) {
      throw new Error(`onTracking[${call}] is not a function`);
    }

    return this.onTracking[call](params, error);
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
        if (this.hasInternetAccess) {
          return this.trackEvent(event);
        }

        throw new Error('Network request failed');
      },
      {
        onSuccess: async (id, event) => { await this.onTrackingInvoke('succeeded', event); },
        onFailure: async (id, event, error) => { await this.onTrackingInvoke('failure', event, error); },
        onFailed: async (id, event, error) => { await this.onTrackingInvoke('failed', event, error); },
        ...WORKERS_OPTIONS,
      },
    );
  };

  addVisitorWorker = () => {
    this.queue.addWorker(
      JOB_VISITOR,
      async (id, event) => {
        if (this.hasInternetAccess) {
          return this.trackVisit(event);
        }

        throw new Error('Network request failed');
      },
      {
        onSuccess: async (id, event) => { await this.onTrackingInvoke('succeeded', event); },
        onFailure: async (id, event, error) => { await this.onTrackingInvoke('failure', event, error); },
        onFailed: async (id, event, error) => { await this.onTrackingInvoke('failed', event, error); },
        ...WORKERS_OPTIONS,
      },
    );
  };

  // =====================
  // - WORKERS
  // =====================
}
