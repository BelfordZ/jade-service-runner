/**
 * TaskManager and TaskProcessManager launch and manage services, keeping services that have been
 * launched alive, until the ServiceRunner process is killed.
 *
 * TaskManager exposes the public interfaces for starting and listing active services
 *
 * TaskProcessManager keeps a record of processes launched, and processes installed. In addition,
 * prior to launching the services, the TaskProcessManager handles resolving any templated
 * service configuration, allocating dynamic ports for services.
 */
import { Repo } from "./repo";
import { Config } from "./config";
import { getOS, getAvailableTCPPort, getAvailableUDPPort } from "./util";
import { spawn } from "child_process";
import { ICommands, IServiceEnv, IEnvArgs, ISequenceCmd } from "./service";
import { makeLogger } from "./logging";
import { template } from "lodash";
export interface ITaskOptions {
  intervalMS: number;
}
// Allows for 3 dynamic TCP Ports and 3 dynamic UDP Ports
interface IDynamicPorts {
  DYNAMIC_TCP_PORT_1: number;
  DYNAMIC_TCP_PORT_2: number;
  DYNAMIC_TCP_PORT_3: number;
  DYNAMIC_UDP_PORT_1: number;
  DYNAMIC_UDP_PORT_2: number;
  DYNAMIC_UDP_PORT_3: number;
}
const logger = makeLogger("ServiceRunner", "TaskManager");
export class TaskManager {

  public repo: Repo;
  public config: Config;
  public options: ITaskOptions | undefined;
  public manager: TaskProcessManager;

  constructor(repo: Repo, config: Config, options?: ITaskOptions) {
    this.repo = repo;
    this.config = config;
    this.options = options;
    this.manager = new TaskProcessManager();
  }

  /**
   * Starts an installed service using the service configuration and manifest entry, and
   * returns service configuration information.
   *
   *
   * @param serviceName - Name of the service
   * @param version - Version of the service
   * @param env - Environment
   * @returns The rendered version of the service configuration
   */
  public async startService(serviceName: string, version: string, env: string) {

    const serviceEntry = await this.repo.getServiceEntry(serviceName, version);
    if (serviceEntry === undefined) { throw new Error("Service does not exists in repo"); }
    const { rpcPort, commands, environments } = this.config.getService(serviceName, getOS());
    const { args } = environments.find((e) => e.name === env) as IServiceEnv;

    const taskService = {
      env,
      version: serviceEntry.version,
      name: serviceName,
      args,
      commands,
      path: serviceEntry.path,
      running: false,
      rpcPort,
    };
    return this.manager.launchTask(taskService);
  }
  /**
   * Returns a list of currently active services
   *
   * @returns The active list of services
   */
  public listActiveServices() {
    const services: ITaskService[] = [];
    this.manager.activeTaskMap.forEach((v) => {

      const { running } = v;
      if (running) { services.push(v); }
    });
    return services;
  }
}

interface ITaskService {
  env: string;
  rpcPort: string;
  name: string;
  version: string;
  path: string;
  commands: ICommands;
  args: IEnvArgs;
  running: boolean;
}

export class TaskProcessManager {

  public taskMap: Map<string, ITaskService>;
  public activeTaskMap: Map<string, ITaskService>;
  constructor() {
    this.taskMap = new Map<string, ITaskService>();
    this.activeTaskMap = new Map<string, ITaskService>();
  }

  /**
   * Launches a service, writing the service to an in memory map of active and templated processes.
   * It spawns new tasks, and catches errors and SIGTERM signals to then re spawn itself. It
   * returns a fully rendered config
   *
   * @param service - Configuration for a templated service
   * @returns The rendered configuration for a service
   */
  public async launchTask(service: ITaskService): Promise<ITaskService> {

    this.addTask(service, this.taskMap);
    const renderedService = await this.renderCommands(service);
    this.addTask(renderedService, this.activeTaskMap);
    // NOTE makes assumption that setup processes exit prior to running the main process
    await this.spawnSeqCommands(renderedService.commands.setup);
    const child = spawn(`${renderedService.commands.start}`, renderedService.args.start);
    const childLogger = makeLogger(service.name, "Active Task");
    child.stdout.on("data", (data) => {
      childLogger.debug(`stdout: ${data}`);
    });

    child.stderr.on("data", (data) => {
      childLogger.error(`stderr: ${data}`);
    });

    child.on("close", (code) => {
      childLogger.debug(`child process exited with code ${code}`);
      this.launchTask(service);
    });
    child.on("error", (err) => {
      childLogger.error(`${service.name}: child process exited with err ${err}`);
      this.launchTask(service);
    });
    service.running = true;
    renderedService.running = true;
    logger.info(`Launched service with ${JSON.stringify(renderedService)}`);
    return renderedService;
  }

  // NOTE makes assumption that setup tasks don't fail
  private async spawnSeqCommands(cmds: ISequenceCmd[]) {
    cmds.forEach(async (cmd) => {
      await new Promise((resolve) => {
        const child = spawn(cmd.cmd, cmd.args);
        child.on("error", (err) => {
          throw err;
        });
        child.on("exit", () => {
          resolve();
        });
      });
    });
  }

  private async getFreePorts(): Promise<IDynamicPorts> {
    const tcpPorts = [1, 2, 3].map(() => getAvailableTCPPort());
    const udpPorts = [1, 2, 3].map(() => getAvailableUDPPort());

    const availPorts = await Promise.all([...tcpPorts, ...udpPorts]) as number[];
    return {
      DYNAMIC_TCP_PORT_1: availPorts[1],
      DYNAMIC_TCP_PORT_2: availPorts[2],
      DYNAMIC_TCP_PORT_3: availPorts[3],
      DYNAMIC_UDP_PORT_1: availPorts[4],
      DYNAMIC_UDP_PORT_2: availPorts[5],
      DYNAMIC_UDP_PORT_3: availPorts[6],
    };
  }

  private addTask(service: ITaskService, taskMap: Map<string, ITaskService>) {
    const hash = this.taskHash(service);
    if (taskMap.has(hash)) { return; }
    taskMap.set(hash, service);
  }

  private taskHash(service: ITaskService): string {
    return `${service.name}_${service.version}_${service.env}`;
  }
  private async renderCommands(service: ITaskService): Promise<ITaskService> {
    // @ts-ignore these are use ambiently by the eval
    const ports = await this.getFreePorts();
    // @ts-ignore is ambiently utilized by template
    const SERVICE_DIR = service.path;
    const dynamicVar = { ...ports, SERVICE_DIR };
    const renderArgs = (cmds: string[]) => cmds.map((cmd) => template(cmd)({ ...dynamicVar }));
    const renderCmd = (cmd: string) => template(cmd)({ ...dynamicVar });
    const renderSequenceCmd = (seqCmds: ISequenceCmd[]) => seqCmds.map((cmd) => {
      return {
        args: renderArgs(cmd.args),
        cmd: renderCmd(cmd.cmd),
      };
    });

    const command = {
      setup: renderSequenceCmd(service.commands.setup),
      start: renderCmd(service.commands.start),
      stop: renderCmd(service.commands.stop),
      teardown: renderCmd(service.commands.teardown),
    };

    const args = {
      start: renderArgs(service.args.start),
      stop: renderArgs(service.args.stop),
      teardown: renderArgs(service.args.teardown),
    };

    const rpcPort = template(service.rpcPort)({ ...dynamicVar });
    return {
      ...service,
      commands: command,
      rpcPort,
      args,
    };
  }

}
