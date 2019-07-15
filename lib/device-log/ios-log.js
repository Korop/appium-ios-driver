import path from 'path';
import _ from 'lodash';
import logger from './logger';
import { fs, mkdirp } from 'appium-support';
import { SubProcess, exec } from 'teen_process';
import events from 'events';
const { EventEmitter } = events;

const START_TIMEOUT = 10000;
const DEVICE_CONSOLE_PATH = path.resolve(__dirname, '..', '..', '..', 'build', 'deviceconsole');
const SYSTEM_LOG_PATH = '/var/log/system.log';
// We keep only the most recent log entries to avoid out of memory error
const MAX_LOG_ENTRIES_COUNT = 5000;

class IOSLog extends EventEmitter {
  constructor (opts) {
    super();
    this.sim = opts.sim;
    this.udid = opts.udid;
    this.showLogs = !!opts.showLogs;
    this.realDeviceLogger = opts.realDeviceLogger || 'idevicesyslog';
    this.xcodeVersion = opts.xcodeVersion;

    this.proc = null;
    this.logs = [];
    this.logRow = '';
    this.logIdxSinceLastRequest = -1;
    this.maxBufferSize = MAX_LOG_ENTRIES_COUNT;
    this.firstLine = true;
    this.genericOutputProcessing = (stdout, stderr) => this.processGenericOutput(stdout, stderr);
    if (IOSLog.id) {
      IOSLog.id = IOSLog.id + 1;
    } else {
      IOSLog.id = 1;
    }
    this.testId = IOSLog.id;

    logger.debug(`IOSLog,testId=${this.testId}: constructor`);
    logger.debug(`IOSLog,testId=${this.testId}: info call stack=${new Error().stack}`);
  }

  async startCaptureRealDevice () {
    let cmd, args, env;
    if ((this.realDeviceLogger || '').indexOf('idevicesyslog') !== -1) {
      logger.debug('Attempting iOS device log capture via libimobiledevice idevicesyslog');
      if (this.realDeviceLogger.toLowerCase() === 'idevicesyslog') {
        cmd = 'idevicesyslog';
        try {
          // make sure it is available on the PATH
          await fs.which('idevicesyslog');
        } catch (err) {
          throw new Error(`Unable to find system idevicesyslog: ${err.message}`);
        }
      } else {
        // make sure the executable exists
        if (!await fs.exists(this.realDeviceLogger)) {
          throw new Error(`Unable to find idevicesyslog from 'realDeviceLogger' capability '${this.realDeviceLogger}'`);
        }
        cmd = this.realDeviceLogger;
      }

      args = ['-u', this.udid];
      env = process.env;
    } else if ((this.realDeviceLogger || '').indexOf('deviceconsole') !== -1) {
      logger.debug('Attempting iOS device log capture via deviceconsole');
      let deviceconsole;
      if (this.realDeviceLogger.toLowerCase() === 'deviceconsole') {
        deviceconsole = DEVICE_CONSOLE_PATH;
      } else {
        // make sure that we have the path to the directory,
        // not the actual executable
        let stat;
        try {
          stat = await fs.stat(this.realDeviceLogger);
        } catch (err) {
          throw new Error(`Unable to find deviceconsole from 'realDeviceLogger' capability '${this.realDeviceLogger}': ${err.message}`);
        }
        if (stat.isDirectory()) {
          deviceconsole = this.realDeviceLogger;
        } else {
          // make sure they've passed in `deviceconsole` and not something random
          if (!_.endsWith(this.realDeviceLogger, 'deviceconsole')) {
            throw new Error(`Unable to parse 'deviceconsole' installation directory from '${this.realDeviceLogger}'`);
          }
          // remove the executable, and trailing `/`, to get the install directory
          deviceconsole = path.dirname(this.realDeviceLogger);
        }
      }

      logger.debug(`Using 'deviceconsole' from '${deviceconsole}'`);

      cmd = `${deviceconsole}/deviceconsole`;
      args = ['-u', this.udid];

      // set up the environment to be able to run deviceconsole
      env = _.clone(process.env);
      env.DYLD_LIBRARY_PATH = deviceconsole;
      if (process.env.DYLD_LIBRARY_PATH) {
        env.DYLD_LIBRARY_PATH = `${env.DYLD_LIBRARY_PATH}:${process.env.DYLD_LIBRARY_PATH}`;
      }
    } else {
      logger.errorAndThrow(`Unable to capture device log. Unknown 'realDeviceLogger': '${this.realDeviceLogger}'`);
    }

    this.subprocessId = `${cmd}_${this.udid}`;

    logger.debug(`Starting iOS device log capture with: '${cmd}', testId=${this.testId}`);

    try {
      // cleanup existing listeners if the previous session has not been terminated properly
      await this.killExistingSysLogProcesses(cmd, args);
    } catch (e) {
      logger.debug(`killExistingSysLogProcesses error: '${e.message}'`);
    }

    // just use one instance of 'idevicesyslog' per udid
    this.proc = this.getIDeviceSysLogProcess(cmd, args, env);

    await this.finishStartingLogCapture();
  }

  async startCaptureSimulator () {
    // otherwise, if we have a simulator...
    logger.debug(`Starting iOS ${await this.sim.getPlatformVersion()} simulator log capture`);
    if (this.xcodeVersion.major < 5) {
      this.proc = new SubProcess('tail', ['-f', '-n', '1', SYSTEM_LOG_PATH]);
      await this.finishStartingLogCapture();
      return;
    }

    // this is xcode 6+
    if (_.isUndefined(this.sim.udid)) {
      logger.errorAndThrow(`iOS log capture with Xcode ${this.xcodeVersion.versionString} requires a sim udid`);
    }

    let logPath = this.sim.getLogDir();
    try {
      if (logPath.indexOf('*') >= 0) {
        logger.error(`Log path has * in it. Unable to start log capture: ${logPath}`);
        return;
      }
      let systemLogPath = path.resolve(logPath, 'system.log');
      logger.debug(`System log path: ${systemLogPath}`);
      await mkdirp(logPath);
      await fs.writeFile(systemLogPath, 'A new Appium session is about to start!\n', {flag: 'a'});
      let files;
      try {
        files = await fs.glob(systemLogPath);
        if (files.length < 1) {
          throw new Error('Could not start log capture');
        }
      } catch (e) {
        logger.error(`Could not start log capture because no iOS ` +
                     `simulator logs could be found at ${systemLogPath}. ` +
                     `Logging will not be functional for this run`);
      }

      let lastModifiedLogPath = files[0];
      let lastModifiedLogTime = (await fs.stat(lastModifiedLogPath)).mtime;
      for (let file of files) {
        let {mtime} = await fs.stat(file);
        if (mtime > lastModifiedLogTime) {
          lastModifiedLogPath = file;
          lastModifiedLogTime = mtime;
        }
      }
      const tailArgs = ['-f', '-n', '1', lastModifiedLogPath];
      try {
        // cleanup existing listeners if the previous session has not been terminated properly
        await exec('pkill', ['-9', '-xf', ['tail', ...tailArgs].join(' ')]);
      } catch (e) {}
      this.proc = new SubProcess('tail', tailArgs);
      await this.finishStartingLogCapture();
    } catch (err) {
      logger.errorAndThrow(`Simulator log capture failed: ${err.message}`);
    }
  }

  async startCapture () {
    if (this.udid) {
      // if we have a real device
      return await this.startCaptureRealDevice();
    }
    return await this.startCaptureSimulator();
  }

  async finishStartingLogCapture () {
    if (!this.proc) {
      logger.errorAndThrow('Could not capture device log');
    }
    // let firstLine = true;
    // this.firstLine = true;
    this.proc.on('output', this.genericOutputProcessing);
    // this.proc.on('output', (stdout, stderr) => {
    //   if (stdout) {
    //     if (firstLine) {
    //       if (stdout.substr(-1, 1) === '\n') {
    //         // don't store the first line of the log because it came before the sim or device was launched
    //         firstLine = false;
    //       }
    //     } else {
    //       this.logRow += stdout;
    //       logger.debug(`finishStartingLogCapture: proc on output, length=${this.logRow.length}`);
    //       if (stdout.substr(-1, 1) === '\n') {
    //         logger.debug(`finishStartingLogCapture: proc on output, find end-of-line, length=${this.logRow.length}`);
    //         this.onOutput();
    //         this.logRow = '';
    //       }
    //     }
    //   }
    //   if (stderr) {
    //     this.onOutput('STDERR');
    //   }
    // });

    let sd = (stdout, stderr) => {
      if (/execvp\(\)/.test(stderr)) {
        logger.error(`finishStartingLogCapture: iOS log capture process failed to start`);
        throw new Error('iOS log capture process failed to start');
      }
      return stdout || stderr;
    };

    if (!this.proc.isRunning) {
      logger.debug(`finishStartingLogCapture,testId=${this.testId}: before this.proc.start(...)`);
      await this.proc.start(sd, START_TIMEOUT);
    }
  }

  async stopCapture () {
    logger.debug(`stopCapture,testId=${this.testId}: start`);
    logger.debug(`stopCapture,testId=${this.testId}: info call stack=${new Error().stack}`);

    if (this.proc) {
      if (this.udid) {
        // If no other UDID's are using 'idevicesyslog' kill it
        const cachedSysLog = IOSLog.cachedIDeviceSysLogs[this.subprocessId];
        if (cachedSysLog) {
          this.proc.removeListener('output', this.genericOutputProcessing);
          cachedSysLog.count--;
          logger.debug(`stopCapture,testId=${this.testId}: subprocessId=${this.subprocessId}, after cachedSysLog.count=${cachedSysLog.count}`);
          if (cachedSysLog.count === 0) {
            await this.killLogSubProcess();
            delete IOSLog.cachedIDeviceSysLogs[this.subprocessId];
          }
        }
      } else {
        await this.killLogSubProcess();
      }
    }
    logger.debug('stopCapture,testId=${this.testId}: end');
    this.proc = null;
  }

  async killLogSubProcess () {
    if (this.proc.isRunning) {
      logger.debug(`Stopping iOS log capture, testId=${this.testId}`);
      try {
        await this.proc.stop('SIGTERM', 1000);
      } catch (e) {
        if (this.proc.isRunning) {
          logger.warn('Cannot stop log capture process. Sending SIGKILL...');
          await this.proc.stop('SIGKILL');
        }
      }
    }
  }

  onOutput (prefix = '') {
    let logs = this.logRow.split('\n');
    for (let log of logs) {
      if (!log) continue; // eslint-disable-line curly
      let logObj = {
        timestamp: Date.now(),
        level: 'ALL',
        message: log
      };
      this.logs.push(logObj);
      // logger.debug(`onOutput,testId=${this.testId}: logs lines=${this.logs.length}`);
      this.emit('output', logObj);
      if (this.logs.length > this.maxBufferSize) {
        this.logs.shift();
        // logger.debug(`onOutput,testId=${this.testId}: after shift logs=${this.logs.length}, maxBufferSize=${this.maxBufferSize}`);
        if (this.logIdxSinceLastRequest > 0) {
          --this.logIdxSinceLastRequest;
        }
      }
      if (this.showLogs) {
        let space = prefix.length > 0 ? ' ' : '';
        logger.info(`[IOS_SYSLOG_ROW${space}${prefix}] ${log}`);
      }
    }
  }

  async getLogs () { // eslint-disable-line require-await
    if (this.logs.length && this.logIdxSinceLastRequest < this.logs.length) {
      let result = this.logs;
      if (this.logIdxSinceLastRequest > 0) {
        result = result.slice(this.logIdxSinceLastRequest);
      }
      this.logIdxSinceLastRequest = this.logs.length;
      return result;
    }
    return [];
  }

  async getAllLogs () { // eslint-disable-line require-await
    return this.logs;
  }

  async killExistingSysLogProcesses (cmd, args) {
    let killPattern = [cmd, ...args].join('[[:space:]]+');
    logger.debug(`killExistingSysLogProcesses,testId=${this.testId}: Before trying to kill SysLog processeses: ${killPattern}`);
    await this.getPidUsingPattern(killPattern);
    if (!IOSLog.cachedIDeviceSysLogs[this.subprocessId]) {
      logger.debug(`killExistingSysLogProcesses,testId=${this.testId}: Trying to kill SysLog processeses: ${killPattern}`);
      logger.debug(`pkill -9 -if '${killPattern}'`);

      await exec('pkill', ['-9', '-if', killPattern]);
    } else {
      logger.debug(`killExistingSysLogProcesses,testId=${this.testId}: Will not kill SysLog processeses, subprocessId='${this.subprocessId}'`);
    }
    await this.getPidUsingPattern(killPattern);
    logger.debug(`killExistingSysLogProcesses,testId=${this.testId}: After trying to kill SysLog processeses: ${killPattern}`);
  }

  async getPidUsingPattern (pgrepPattern) {
    const args = ['-if', '-d', ',', pgrepPattern];
    try {
      const { stdout, stderr } = await exec('bash', ['-c', `pgrep -if -d , '${pgrepPattern}'`]);
      logger.debug(`getPidUsingPattern: pgrep pids line for pattern '${pgrepPattern}' is '${stdout}', error='${stderr}'`);
      if (typeof (stdout) !== 'undefined' && stdout) {
        let pids = stdout.replace(/\s/g, '').replace(/,$/g, '');
        logger.debug(`getPidUsingPattern: return pids='${pids}'`);
        return pids;
      } else {
        logger.debug(`getPidUsingPattern: cannot find a process by pattern 'pgrep ${args.join(' ')}'`);
        return null;
      }

    } catch (err) {
      logger.debug(`getPidUsingPattern: 'pgrep ${args.join(' ')}' didn't detect any matching processes. Return code: ${err.message}`);
      return null;
    }
  }

  /**
   * Get 'idevicesyslog' subprocess for a given udid.
   *
   * This function caches and re-uses instances so that there's
   * just one instance per device (cache by UDID)
   */
  getIDeviceSysLogProcess (cmd, args, env) {
    logger.debug(`getIDeviceSysLogProcess,testId=${this.testId}: Start for subprocessId=${this.subprocessId}, IOSLog cached='${IOSLog.cachedIDeviceSysLogs[this.subprocessId]}'`);
    if (!IOSLog.cachedIDeviceSysLogs[this.subprocessId]) {
      logger.debug(`getIDeviceSysLogProcess: create new subprocess, for subprocessId=${this.subprocessId}, cmd=${cmd}, args=${args.join(' ')}`);
      let {proc} = IOSLog.cachedIDeviceSysLogs[this.subprocessId] = {
        proc: new SubProcess(cmd, args, {env}),
        count: 1,
      };
      // If the process dies, remove it from the cache
      proc.on('exit', (code, signal) => {
        logger.debug(`getIDeviceSysLogProcess,testId=${this.testId}: On exited with code ${code} from signal ${signal}`);
        logger.debug(`getIDeviceSysLogProcess,testId=${this.testId}: On exited, subprocessId='${this.subprocessId}', IOSLog to delete from cache='${IOSLog.cachedIDeviceSysLogs[this.subprocessId]}'`);
        delete IOSLog.cachedIDeviceSysLogs[this.subprocessId];
      });
    } else {
      IOSLog.cachedIDeviceSysLogs[this.subprocessId].count++;
      logger.debug(`getIDeviceSysLogProcess,testId=${this.testId}: increase count for subprocessId='${this.subprocessId}', IOSLog from cache='${IOSLog.cachedIDeviceSysLogs[this.subprocessId]}', count='${IOSLog.cachedIDeviceSysLogs[this.subprocessId].count}'`);
    }
    logger.debug(`getIDeviceSysLogProcess,testId=${this.testId}: End for subprocessId=${this.subprocessId}, IOSLog cached='${JSON.stringify(IOSLog.cachedIDeviceSysLogs[this.subprocessId])}'`);
    return IOSLog.cachedIDeviceSysLogs[this.subprocessId].proc;
  }

  processGenericOutput (stdout, stderr) {
    if (stdout) {
      if (this.firstLine) {
        if (stdout.substr(-1, 1) === '\n') {
          // don't store the first line of the log because it came before the sim or device was launched
          this.firstLine = false;
        }
      } else {
        this.logRow += stdout;
        // logger.debug(`finishStartingLogCapture,testId=${this.testId}: proc on output, length=${this.logRow.length}`);
        if (stdout.substr(-1, 1) === '\n') {
          // logger.debug(`finishStartingLogCapture,testId=${this.testId}: proc on output, find end-of-line, length=${this.logRow.length}`);
          this.onOutput();
          this.logRow = '';
        }
      }
    }
    if (stderr) {
      this.onOutput('STDERR');
    }
  }

}


IOSLog.cachedIDeviceSysLogs = {};

export { IOSLog, DEVICE_CONSOLE_PATH };
export default IOSLog;
