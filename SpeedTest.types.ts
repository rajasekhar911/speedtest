/*
	LibreSpeed - Main
	by Federico Dossena
	https://github.com/librespeed/speedtest/
	GNU LGPLv3 License
*/

export const BYTES_PER_MEGABYTE = 1048576;
export const BYTES_PER_MEGABIT = 1000000;
export const BITS_PER_BYTE = 8;
export const UPDATE_INTERVAL_MS = 200;
export const DELAY_STEP_MS = 1000;
export const MAX_BONUS_MS = 400;
export const BONUS_SPEED_DIVISOR = 100000;
export const BONUS_MULTIPLIER = 5.0;
export const JITTER_WEIGHT_HIGH = 0.7;
export const JITTER_WEIGHT_LOW = 0.2;
export const PAYLOAD_CHUNK_SIZE = 1024 * 1024;

export interface SpeedTestStatus {
  testState: number;
  dlStatus: string;
  ulStatus: string;
  pingStatus: string;
  jitterStatus: string;
  clientIp: string;
  dlProgress: number;
  ulProgress: number;
  pingProgress: number;
  testId: string | null;
  testStatus: 'success' | 'failed' | 'aborted' | null;
}

export interface SpeedTestSettings {
  test_order: string;
  time_ul_max: number;
  time_dl_max: number;
  time_auto: boolean;
  time_ulGraceTime: number;
  time_dlGraceTime: number;
  count_ping: number;
  url_dl: string;
  url_ul: string;
  url_ping: string;
  url_getIp: string;
  getIp_ispInfo: boolean;
  getIp_ispInfo_distance: string;
  xhr_dlMultistream: number;
  xhr_ulMultistream: number;
  xhr_multistreamDelay: number;
  xhr_ignoreErrors: number;
  xhr_dlUseBlob: boolean;
  xhr_ul_blob_megabytes: number;
  garbagePhp_chunkSize: number;
  enable_quirks: boolean;
  ping_allowPerformanceApi: boolean;
  overheadCompensationFactor: number;
  useMebibits: boolean;
  telemetry_level: number;
  url_telemetry: string;
  telemetry_extra: string;
}

export type StatusCallback = (status: SpeedTestStatus) => void;

export enum TestState {
  NOT_STARTED = -1,
  STARTING = 0,
  DOWNLOAD = 1,
  PING_JITTER = 2,
  UPLOAD = 3,
  FINISHED = 4,
  ABORTED = 5
}
