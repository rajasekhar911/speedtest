/*
	LibreSpeed - Main
	by Federico Dossena
	https://github.com/librespeed/speedtest/
	GNU LGPLv3 License
*/

import axios, {CancelTokenSource} from 'axios';
import {
  BYTES_PER_MEGABYTE,
  BYTES_PER_MEGABIT,
  BITS_PER_BYTE,
  UPDATE_INTERVAL_MS,
  DELAY_STEP_MS,
  MAX_BONUS_MS,
  BONUS_SPEED_DIVISOR,
  BONUS_MULTIPLIER,
  JITTER_WEIGHT_HIGH,
  JITTER_WEIGHT_LOW,
  PAYLOAD_CHUNK_SIZE,
  SpeedTestStatus,
  SpeedTestSettings,
  StatusCallback,
  TestState
} from './SpeedTest.types';

class SpeedTest {
  private status: SpeedTestStatus = {
    testState: TestState.NOT_STARTED,
    dlStatus: '',
    ulStatus: '',
    pingStatus: '',
    jitterStatus: '',
    clientIp: '',
    dlProgress: 0,
    ulProgress: 0,
    pingProgress: 0,
    testId: null,
    testStatus: null
  };

  private settings: SpeedTestSettings = {
    test_order: 'IP_D_U',
    time_ul_max: 15,
    time_dl_max: 15,
    time_auto: true,
    time_ulGraceTime: 1.5,
    time_dlGraceTime: 1.5,
    count_ping: 10,
    url_dl: '',
    url_ul: '',
    url_ping: '',
    url_getIp: '',
    getIp_ispInfo: true,
    getIp_ispInfo_distance: 'km',
    xhr_dlMultistream: 3,
    xhr_ulMultistream: 3,
    xhr_multistreamDelay: 300,
    xhr_ignoreErrors: 1,
    xhr_dlUseBlob: false,
    xhr_ul_blob_megabytes: 20,
    garbagePhp_chunkSize: 100,
    enable_quirks: true,
    ping_allowPerformanceApi: true,
    overheadCompensationFactor: 1.06,
    useMebibits: false,
    telemetry_level: 0,
    url_telemetry: '',
    telemetry_extra: ''
  };

  private callback: StatusCallback | null = null;
  private cancelTokenSource: CancelTokenSource | null = null;
  private interval: any = null;
  private testPointer = 0;
  private testsRun = {
    ip: false,
    download: false,
    upload: false,
    ping: false
  };

  constructor(urls?: Record<string, string>, callback?: StatusCallback) {
    console.log("SpeedTest native")
    if (callback) {
      this.callback = callback;
    }
    if (urls) {
      this.configureEndpoints(urls);
    }
  }

  private configureEndpoints(urls: Record<string, string>): void {
    this.settings.url_dl = urls.download;
    this.settings.url_ul = urls.upload;
    this.settings.url_ping = urls.ping;
    this.settings.url_getIp = urls.getIp;
    this.settings.url_telemetry = urls.telemetry;
  }

  private updateStatus(): void {
    if (this.callback) {
      this.callback({...this.status});
    }
  }

  public setSettings(s: Partial<SpeedTestSettings>): void {
    this.settings = {...this.settings, ...s};
  }

  public abort(): void {
    if (this.status.testState >= TestState.FINISHED) return;

    if (this.cancelTokenSource) {
      this.cancelTokenSource.cancel('Aborted by user');
    }
    if (this.interval) {
      clearInterval(this.interval);
    }
    this.status.testState = TestState.ABORTED;
    this.status.testStatus = 'aborted';
    this.updateStatus();
  }

  public async run(): Promise<void> {
    const canStart =
      this.status.testState === TestState.NOT_STARTED ||
      this.status.testState === TestState.FINISHED;

    if (!canStart) {
      console.debug('[SpeedTest] Cannot start - test already running');
      return;
    }

    console.debug('[SpeedTest] Starting new test');

    this.status = {
      testState: TestState.STARTING,
      dlStatus: '',
      ulStatus: '',
      pingStatus: '',
      jitterStatus: '',
      clientIp: this.status.clientIp,
      dlProgress: 0,
      ulProgress: 0,
      pingProgress: 0,
      testId: null,
      testStatus: null
    };

    this.updateStatus();
    this.cancelTokenSource = axios.CancelToken.source();
    this.testPointer = 0;
    this.testsRun = {
      ip: false,
      download: false,
      upload: false,
      ping: false
    };

    await this.processNextStep();
  }

  private async processNextStep(): Promise<void> {
    if (this.status.testState === TestState.ABORTED) return;

    if (this.testPointer >= this.settings.test_order.length) {
      console.debug('[SpeedTest] All tests complete');
      this.status.testState = TestState.FINISHED;

      const hasFailed =
        this.status.dlStatus === 'Fail' ||
        this.status.ulStatus === 'Fail' ||
        this.status.pingStatus === 'Fail' ||
        !this.status.dlStatus ||
        !this.status.ulStatus ||
        !this.status.pingStatus ||
        this.status.dlStatus === '0.00' ||
        this.status.ulStatus === '0.00';

      this.status.testStatus = hasFailed ? 'failed' : 'success';

      this.updateStatus();
      return;
    }

    const char = this.settings.test_order.charAt(this.testPointer);
    console.debug(`[SpeedTest] Processing step ${this.testPointer}: '${char}'`);
    this.testPointer++;

    switch (char) {
      case 'I':
        if (!this.testsRun.ip) {
          this.testsRun.ip = true;
          await this.getIp();
        }
        break;
      case 'D':
        if (!this.testsRun.download) {
          this.testsRun.download = true;
          this.status.testState = TestState.DOWNLOAD;
          this.updateStatus();
          await this.dlTest();
        }
        break;
      case 'U':
        if (!this.testsRun.upload) {
          this.testsRun.upload = true;
          this.status.testState = TestState.UPLOAD;
          this.updateStatus();
          await this.ulTest();
        }
        break;
      case 'P':
        if (!this.testsRun.ping) {
          this.testsRun.ping = true;
          this.status.testState = TestState.PING_JITTER;
          this.updateStatus();
          await this.pingTest();
        }
        break;
      case '_':
        await this.delay(DELAY_STEP_MS);
        break;
      default:
        break;
    }

    await this.processNextStep();
  }

  private now(): number {
    return typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private buildUrl(
    baseUrl: string,
    params: Record<string, string | number>
  ): string {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const queryString = Object.entries(params)
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    return `${baseUrl}${sep}${queryString}`;
  }

  private calculateSpeed(bytesLoaded: number, timeMs: number): number {
    const bytesPerSecond = bytesLoaded / (timeMs / 1000.0);
    const bitsPerSecond =
      bytesPerSecond * BITS_PER_BYTE * this.settings.overheadCompensationFactor;
    const divisor = this.settings.useMebibits
      ? BYTES_PER_MEGABYTE
      : BYTES_PER_MEGABIT;
    return bitsPerSecond / divisor;
  }

  private async getIp(): Promise<void> {
    const {url_getIp, getIp_ispInfo, getIp_ispInfo_distance} = this.settings;

    const params: Record<string, string> = {r: String(Math.random())};
    if (getIp_ispInfo) {
      params.isp = 'true';
      if (getIp_ispInfo_distance) {
        params.distance = getIp_ispInfo_distance;
      }
    }

    const url = this.buildUrl(url_getIp, params);

    try {
      const response = await axios.get(url, {
        cancelToken: this.cancelTokenSource?.token
      });

      let data: any = response.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (e) {}
      }

      if (typeof data === 'object' && data?.processedString) {
        this.status.clientIp = data.processedString;
      } else {
        this.status.clientIp =
          typeof data === 'string' ? data : JSON.stringify(data);
      }
      this.updateStatus();
    } catch (e) {
      console.warn('[SpeedTest] getIp failed', e);
    }
  }

  private async dlTest(): Promise<void> {
    console.debug('[SpeedTest] Starting download test');
    this.cancelTokenSource = axios.CancelToken.source();

    const {
      xhr_dlMultistream,
      xhr_multistreamDelay,
      time_dl_max,
      time_dlGraceTime
    } = this.settings;

    this.status.dlStatus = '';
    this.status.dlProgress = 0;

    let totLoaded = 0;
    const getTot = () => totLoaded;
    const addTot = (diff: number) => {
      totLoaded += diff;
    };

    await this.runSpeedTest({
      testState: TestState.DOWNLOAD,
      streamCount: xhr_dlMultistream,
      streamDelay: xhr_multistreamDelay,
      maxTime: time_dl_max,
      graceTime: time_dlGraceTime,
      getTotalLoaded: getTot,
      addToTotal: addTot,
      updateProgress: (progress) => {
        this.status.dlProgress = progress;
      },
      updateSpeed: (speed) => {
        this.status.dlStatus = speed;
      },
      runStream: (i) => this.runDlStream(i, getTot, addTot)
    });
  }

  private async ulTest(): Promise<void> {
    console.debug('[SpeedTest] Initializing upload test');
    this.cancelTokenSource = axios.CancelToken.source();

    const {
      xhr_ulMultistream,
      xhr_multistreamDelay,
      time_ul_max,
      time_ulGraceTime,
      xhr_ul_blob_megabytes
    } = this.settings;

    this.status.ulStatus = '';
    this.status.ulProgress = 0;

    const payloadSize = Math.round(xhr_ul_blob_megabytes * BYTES_PER_MEGABYTE);
    const payload = this.generatePayload(payloadSize);
    console.debug(`[SpeedTest] Generated ${payload.length} byte payload`);

    let totLoaded = 0;
    const getTot = () => totLoaded;
    const addTot = (diff: number) => {
      totLoaded += diff;
    };

    await this.runSpeedTest({
      testState: TestState.UPLOAD,
      streamCount: xhr_ulMultistream,
      streamDelay: xhr_multistreamDelay,
      maxTime: time_ul_max,
      graceTime: time_ulGraceTime,
      getTotalLoaded: getTot,
      addToTotal: addTot,
      updateProgress: (progress) => {
        this.status.ulProgress = progress;
      },
      updateSpeed: (speed) => {
        this.status.ulStatus = speed;
      },
      runStream: (i) => this.runUlStream(i, payload, getTot, addTot)
    });
  }

  private generatePayload(size: number): string {
    const numChunks = Math.ceil(size / PAYLOAD_CHUNK_SIZE);
    const chunk = 'x'.repeat(PAYLOAD_CHUNK_SIZE);
    let data = '';

    for (let i = 0; i < numChunks - 1; i++) {
      data += chunk;
    }

    const remaining = size - (numChunks - 1) * PAYLOAD_CHUNK_SIZE;
    if (remaining > 0) {
      data += 'x'.repeat(remaining);
    }

    return data;
  }

  private async runSpeedTest(config: {
    testState: TestState;
    streamCount: number;
    streamDelay: number;
    maxTime: number;
    graceTime: number;
    getTotalLoaded: () => number;
    addToTotal: (diff: number) => void;
    updateProgress: (progress: number) => void;
    updateSpeed: (speed: string) => void;
    runStream: (index: number) => void;
  }): Promise<void> {
    let startT = this.now();
    let bonusT = 0;
    let graceTimeDone = false;

    console.debug(
      `[SpeedTest] runSpeedTest started - maxTime: ${config.maxTime}s, graceTime: ${config.graceTime}s`
    );
    console.debug(`[SpeedTest] CancelToken exists: ${!!this.cancelTokenSource}`);

    this.interval = setInterval(() => {
      const t = this.now() - startT;

      if (graceTimeDone) {
        config.updateProgress((t + bonusT) / (config.maxTime * 1000));
      }

      if (t < UPDATE_INTERVAL_MS) return;

      if (!graceTimeDone) {
        if (t > 1000 * config.graceTime) {
          const currentTotal = config.getTotalLoaded();
          console.debug(
            `[SpeedTest] Grace time ended at t=${t.toFixed(
              0
            )}ms, totLoaded=${currentTotal}`
          );
          if (currentTotal > 0) {
            startT = this.now();
            bonusT = 0;
            config.addToTotal(-currentTotal);
            console.debug(
              '[SpeedTest] Timer, bonus, and data counter reset after grace period'
            );
          }
          graceTimeDone = true;
        }
      } else {
        const totLoaded = config.getTotalLoaded();
        const speed = this.calculateSpeed(totLoaded, t);

        if (this.settings.time_auto) {
          const bytesPerSecond = totLoaded / (t / 1000.0);
          const bonus =
            (BONUS_MULTIPLIER * bytesPerSecond) / BONUS_SPEED_DIVISOR;
          bonusT += Math.min(bonus, MAX_BONUS_MS);
        }

        config.updateSpeed(speed.toFixed(2));

        const elapsedSeconds = (t + bonusT) / 1000.0;
        if (elapsedSeconds > config.maxTime) {
          console.debug(
            `[SpeedTest] Test complete - ran for ${elapsedSeconds.toFixed(
              2
            )}s, totLoaded: ${totLoaded} bytes, speed: ${speed.toFixed(2)} Mbps`
          );
          if (isNaN(speed)) {
            config.updateSpeed('Fail');
          }
          config.updateProgress(1);
          clearInterval(this.interval!);
          console.debug('[SpeedTest] Stopping streams (test duration reached)');
          this.cancelTokenSource?.cancel('Test complete');
          this.updateStatus();
        } else {
          this.updateStatus();
        }
      }
    }, UPDATE_INTERVAL_MS);

    return new Promise<void>((resolve) => {
      const checkEnd = setInterval(() => {
        const progress =
          config.testState === TestState.DOWNLOAD
            ? this.status.dlProgress
            : this.status.ulProgress;

        if (progress >= 1 || this.status.testState === TestState.ABORTED) {
          clearInterval(checkEnd);
          if (this.interval) clearInterval(this.interval);
          resolve();
        }
      }, UPDATE_INTERVAL_MS);

      console.debug(`[SpeedTest] Launching ${config.streamCount} streams`);
      for (let i = 0; i < config.streamCount; i++) {
        const delay = config.streamDelay * i;
        console.debug(`[SpeedTest] Scheduling stream ${i} with delay ${delay}ms`);
        setTimeout(() => {
          console.debug(
            `[SpeedTest] Stream ${i} setTimeout fired, testState=${this.status.testState}, expected=${config.testState}`
          );
          if (this.status.testState === config.testState) {
            console.debug(`[SpeedTest] Calling runStream for stream ${i}`);
            config.runStream(i);
          } else {
            console.debug(`[SpeedTest] Skipping stream ${i} - wrong test state`);
          }
        }, delay);
      }
    });
  }

  private async runDlStream(
    streamIndex: number,
    getTot: () => number,
    addTot: (n: number) => void
  ): Promise<void> {
    const {url_dl, garbagePhp_chunkSize} = this.settings;
    const url = this.buildUrl(url_dl, {
      r: Math.random(),
      ckSize: garbagePhp_chunkSize
    });

    let prevLoaded = 0;

    try {
      await axios.get(url, {
        responseType: 'blob',
        cancelToken: this.cancelTokenSource?.token,
        onDownloadProgress: (progressEvent) => {
          if (this.status.testState !== TestState.DOWNLOAD) return;

          const diff = progressEvent.loaded - prevLoaded;
          if (diff > 0) {
            addTot(diff);
            prevLoaded = progressEvent.loaded;
          }
        }
      });

      if (this.status.testState === TestState.DOWNLOAD) {
        this.runDlStream(streamIndex, getTot, addTot);
      }
    } catch (e) {
      this.handleStreamError(e, url, streamIndex, 'Download', () => {
        if (this.status.testState === TestState.DOWNLOAD) {
          this.runDlStream(streamIndex, getTot, addTot);
        }
      });
    }
  }

  private async runUlStream(
    streamIndex: number,
    data: string,
    getTot: () => number,
    addTot: (n: number) => void
  ): Promise<void> {
    const url = this.buildUrl(this.settings.url_ul, {r: Math.random()});
    let prevLoaded = 0;

    try {
      console.debug(
        `[SpeedTest] Stream ${streamIndex} uploading ${data.length} bytes`
      );

      await axios.post(url, data, {
        headers: {'Content-Type': 'application/octet-stream'},
        cancelToken: this.cancelTokenSource?.token,
        onUploadProgress: (progressEvent) => {
          if (this.status.testState !== TestState.UPLOAD) return;

          const diff = progressEvent.loaded - prevLoaded;
          if (diff > 0) {
            addTot(diff);
            prevLoaded = progressEvent.loaded;
          }
        }
      });

      if (this.status.testState === TestState.UPLOAD) {
        this.runUlStream(streamIndex, data, getTot, addTot);
      }
    } catch (e) {
      this.handleStreamError(e, url, streamIndex, 'Upload', () => {
        if (this.status.testState === TestState.UPLOAD) {
          this.runUlStream(streamIndex, data, getTot, addTot);
        }
      });
    }
  }

  private handleStreamError(
    error: unknown,
    url: string,
    streamIndex: number,
    testType: 'Download' | 'Upload',
    retryCallback: () => void
  ): void {
    if (axios.isCancel(error)) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'test complete';
      console.debug(`[SpeedTest] Stream ${streamIndex} stopped (${message})`);
      return;
    }

    if (axios.isAxiosError(error)) {
      if (error.response && error.response.status >= 400) {
        console.error(
          `[SpeedTest] Fatal error in ${testType} stream ${streamIndex}:`,
          error.response.status,
          url
        );

        if (testType === 'Download') {
          this.status.dlStatus = 'Fail';
          this.status.testStatus = 'failed';
        } else {
          this.status.ulStatus = 'Fail';
          this.status.testStatus = 'failed';
        }
        this.abort();
        return;
      }

      console.warn(`[SpeedTest] ${testType} stream ${streamIndex} error:`, {
        message: error.message,
        code: error.code,
        status: error.response?.status
      });
    } else {
      console.error(
        `[SpeedTest] ${testType} stream ${streamIndex} unexpected error:`,
        error
      );
    }

    if (this.settings.xhr_ignoreErrors === 1) {
      retryCallback();
    }
  }

  private async pingTest(): Promise<void> {
    console.debug('[SpeedTest] Starting ping test');
    this.cancelTokenSource = axios.CancelToken.source();

    const {url_ping, count_ping} = this.settings;
    let ping = 0;
    let jitter = 0;
    let prevInstspd = 0;

    for (let i = 0; i < count_ping; i++) {
      if (this.status.testState === TestState.ABORTED) break;

      this.status.pingProgress = i / count_ping;
      this.updateStatus();

      const url = this.buildUrl(url_ping, {r: Math.random()});
      const startTime = this.now();

      try {
        await axios.get(url, {
          cancelToken: this.cancelTokenSource?.token
        });

        let instspd = this.now() - startTime;

        if (instspd < 1) instspd = prevInstspd || 1;

        const instjitter = Math.abs(instspd - prevInstspd);

        if (i === 0) {
          ping = instspd;
        } else {
          ping = Math.min(ping, instspd);

          if (i === 1) {
            jitter = instjitter;
          } else {
            const weight =
              instjitter > jitter ? JITTER_WEIGHT_HIGH : JITTER_WEIGHT_LOW;
            jitter = jitter * (1 - weight) + instjitter * weight;
          }
        }

        prevInstspd = instspd;
        this.status.pingStatus = ping.toFixed(2);
        this.status.jitterStatus = jitter.toFixed(2);
        this.updateStatus();
      } catch (e) {
        console.warn(`[SpeedTest] Ping ${i} failed:`, e);
      }
    }

    this.status.pingProgress = 1;
    this.updateStatus();
  }
}

export default SpeedTest;
