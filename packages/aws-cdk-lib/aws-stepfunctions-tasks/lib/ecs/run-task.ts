import { Construct } from 'constructs';
import { ContainerOverride } from '..';
import * as ec2 from '../../../aws-ec2';
import * as ecs from '../../../aws-ecs';
import * as iam from '../../../aws-iam';
import * as sfn from '../../../aws-stepfunctions';
import * as cdk from '../../../core';
import { ValidationError } from '../../../core';
import { propertyInjectable } from '../../../core/lib/prop-injectable';
import { STEPFUNCTIONS_TASKS_FIX_RUN_ECS_TASK_POLICY } from '../../../cx-api';
import { integrationResourceArn, validatePatternSupported } from '../private/task-utils';

interface EcsRunTaskOptions {
  /**
   * The ECS cluster to run the task on
   */
  readonly cluster: ecs.ICluster;

  /**
   * [disable-awslint:ref-via-interface]
   * Task Definition used for running tasks in the service.
   *
   * Note: this must be TaskDefinition, and not ITaskDefinition,
   * as it requires properties that are not known for imported task definitions
   * If you want to run a RunTask with an imported task definition,
   * consider using CustomState
   */
  readonly taskDefinition: ecs.TaskDefinition;

  /**
   * The revision number of ECS task definition family
   *
   * @default - '$latest'
   */
  readonly revisionNumber?: number;

  /**
   * Container setting overrides
   *
   * Specify the container to use and the overrides to apply.
   *
   * @default - No overrides
   */
  readonly containerOverrides?: ContainerOverride[];

  /**
   * Subnets to place the task's ENIs
   *
   * @default - Public subnets if assignPublicIp is set. Private subnets otherwise.
   */
  readonly subnets?: ec2.SubnetSelection;

  /**
   * Existing security groups to use for the tasks
   *
   * @default - A new security group is created
   */
  readonly securityGroups?: ec2.ISecurityGroup[];

  /**
   * Assign public IP addresses to each task
   *
   * @default false
   */
  readonly assignPublicIp?: boolean;

  /**
   * An Amazon ECS launch type determines the type of infrastructure on which your
   * tasks and services are hosted.
   *
   * @see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/launch_types.html
   */
  readonly launchTarget: IEcsLaunchTarget;

  /**
   * Specifies whether to propagate the tags from the task definition to the task.
   * An error will be received if you specify the SERVICE option when running a task.
   *
   * @see https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html#ECS-RunTask-request-propagateTags
   *
   * @default - No tags are propagated.
   */
  readonly propagatedTagSource?: ecs.PropagatedTagSource;

  /**
   * Whether ECS Exec should be enabled
   *
   * @see https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html#ECS-RunTask-request-enableExecuteCommand
   *
   * @default false
   */
  readonly enableExecuteCommand?: boolean;

  /**
   * Cpu setting override
   * @see https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_TaskOverride.html
   * @default - No override
   */
  readonly cpu?: string;

  /**
   * Memory setting override
   * @see https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_TaskOverride.html
   * @default - No override
   */
  readonly memoryMiB?: string;
}

/**
 * An Amazon ECS launch type determines the type of infrastructure on which your tasks and services are hosted.
 * @see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/launch_types.html
 */
export interface IEcsLaunchTarget {
  /**
   * called when the ECS launch target is configured on RunTask
   */
  bind(task: EcsRunTask, launchTargetOptions: LaunchTargetBindOptions): EcsLaunchTargetConfig;
}

/**
 * Options for binding a launch target to an ECS run job task
 */
export interface LaunchTargetBindOptions {
  /**
   * Task definition to run Docker containers in Amazon ECS
   */
  readonly taskDefinition: ecs.ITaskDefinition;

  /**
   * A regional grouping of one or more container instances on which you can run
   * tasks and services.
   *
   * @default - No cluster
   */
  readonly cluster?: ecs.ICluster;
}

/**
 * Configuration options for the ECS launch type
 */
export interface EcsLaunchTargetConfig {
  /**
   * Additional parameters to pass to the base task
   *
   * @default - No additional parameters passed
   */
  readonly parameters?: { [key: string]: any };
}

/**
 * Properties to define an ECS service
 */
export interface EcsFargateLaunchTargetOptions {
  /**
   * Refers to a specific runtime environment for Fargate task infrastructure.
   * Fargate platform version is a combination of the kernel and container runtime versions.
   *
   * @see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/platform_versions.html
   */
  readonly platformVersion: ecs.FargatePlatformVersion;
}

/**
 * Options to run an ECS task on EC2 in StepFunctions and ECS
 */
export interface EcsEc2LaunchTargetOptions {
  /**
   * Placement constraints
   *
   * @default  - None
   */
  readonly placementConstraints?: ecs.PlacementConstraint[];

  /**
   * Placement strategies
   *
   * @default - None
   */
  readonly placementStrategies?: ecs.PlacementStrategy[];
}

/**
 * Configuration for running an ECS task on Fargate
 *
 * @see https://docs.aws.amazon.com/AmazonECS/latest/userguide/launch_types.html#launch-type-fargate
 */
export class EcsFargateLaunchTarget implements IEcsLaunchTarget {
  constructor(private readonly options?: EcsFargateLaunchTargetOptions) {}

  /**
   * Called when the Fargate launch type configured on RunTask
   */
  public bind(task: EcsRunTask, launchTargetOptions: LaunchTargetBindOptions): EcsLaunchTargetConfig {
    if (!launchTargetOptions.taskDefinition.isFargateCompatible) {
      throw new ValidationError('Supplied TaskDefinition is not compatible with Fargate', task);
    }

    return {
      parameters: {
        LaunchType: 'FARGATE',
        PlatformVersion: this.options?.platformVersion,
      },
    };
  }
}

/**
 * Configuration for running an ECS task on EC2
 *
 * @see https://docs.aws.amazon.com/AmazonECS/latest/userguide/launch_types.html#launch-type-ec2
 */
export class EcsEc2LaunchTarget implements IEcsLaunchTarget {
  constructor(private readonly options?: EcsEc2LaunchTargetOptions) {}
  /**
   * Called when the EC2 launch type is configured on RunTask
   */
  public bind(task: EcsRunTask, launchTargetOptions: LaunchTargetBindOptions): EcsLaunchTargetConfig {
    if (!launchTargetOptions.taskDefinition.isEc2Compatible) {
      throw new ValidationError('Supplied TaskDefinition is not compatible with EC2', task);
    }

    if (!launchTargetOptions.cluster?.hasEc2Capacity) {
      throw new ValidationError('Cluster for this service needs Ec2 capacity. Call addCapacity() on the cluster.', task);
    }

    return {
      parameters: {
        LaunchType: 'EC2',
        // takes an array of placement constraints each of which contain a single item array of constraints, flattens it
        // and renders the Json to be passed as a parameter in the state machine.
        // input: [ecs.PlacementConstraint.distinctInstances()] - distinctInstances() returns [{ type: 'distinctInstance' }]
        // output: {Type: 'distinctInstance'}
        PlacementConstraints: noEmpty(flatten((this.options?.placementConstraints ?? []).map((c) => c.toJson().map(uppercaseKeys)))),
        PlacementStrategy: noEmpty(flatten((this.options?.placementStrategies ?? []).map((c) => c.toJson().map(uppercaseKeys)))),
      },
    };

    function uppercaseKeys(obj: { [key: string]: any }): { [key: string]: any } {
      const ret: { [key: string]: any } = {};
      for (const key of Object.keys(obj)) {
        ret[key.slice(0, 1).toUpperCase() + key.slice(1)] = obj[key];
      }
      return ret;
    }

    function flatten<A>(xs: A[][]): A[] {
      return Array.prototype.concat([], ...xs);
    }

    function noEmpty<A>(xs: A[]): A[] | undefined {
      if (xs.length === 0) {
        return undefined;
      }
      return xs;
    }
  }
}

/**
 * Properties for ECS Tasks using JSONPath
 */
export interface EcsRunTaskJsonPathProps extends sfn.TaskStateJsonPathBaseProps, EcsRunTaskOptions {}

/**
 * Properties for ECS Tasks using JSONata
 */
export interface EcsRunTaskJsonataProps extends sfn.TaskStateJsonataBaseProps, EcsRunTaskOptions {}

/**
 * Properties for ECS Tasks
 */
export interface EcsRunTaskProps extends sfn.TaskStateBaseProps, EcsRunTaskOptions {}

/**
 * Run a Task on ECS or Fargate
 */
@propertyInjectable
export class EcsRunTask extends sfn.TaskStateBase implements ec2.IConnectable {
  /**
   * Uniquely identifies this class.
   */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-stepfunctions-tasks.EcsRunTask';

  /**
   * Run a Task that using JSONPath on ECS or Fargate
   */
  public static jsonPath(scope: Construct, id: string, props: EcsRunTaskJsonPathProps) {
    return new EcsRunTask(scope, id, props);
  }

  /**
   * Run a Task that using JSONata on ECS or Fargate
   */
  public static jsonata(scope: Construct, id: string, props: EcsRunTaskJsonataProps) {
    return new EcsRunTask(scope, id, {
      ...props,
      queryLanguage: sfn.QueryLanguage.JSONATA,
    });
  }

  private static readonly SUPPORTED_INTEGRATION_PATTERNS: sfn.IntegrationPattern[] = [
    sfn.IntegrationPattern.REQUEST_RESPONSE,
    sfn.IntegrationPattern.RUN_JOB,
    sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
  ];

  /**
   * Manage allowed network traffic for this service
   */
  public readonly connections: ec2.Connections = new ec2.Connections();

  protected readonly taskMetrics?: sfn.TaskMetricsConfig;
  protected readonly taskPolicies?: iam.PolicyStatement[];

  private securityGroups: ec2.ISecurityGroup[] = [];
  private networkConfiguration?: any;
  private readonly integrationPattern: sfn.IntegrationPattern;

  constructor(scope: Construct, id: string, private readonly props: EcsRunTaskProps) {
    super(scope, id, props);
    this.integrationPattern = props.integrationPattern ?? sfn.IntegrationPattern.REQUEST_RESPONSE;

    validatePatternSupported(this.integrationPattern, EcsRunTask.SUPPORTED_INTEGRATION_PATTERNS);

    if (this.integrationPattern === sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN
      && !sfn.FieldUtils.containsTaskToken(props.containerOverrides?.map(override => override.environment))) {
      throw new ValidationError('Task Token is required in at least one `containerOverrides.environment` for callback. Use JsonPath.taskToken to set the token.', this);
    }

    if (!this.props.taskDefinition.defaultContainer) {
      throw new ValidationError('A TaskDefinition must have at least one essential container', this);
    }

    if (this.props.taskDefinition.networkMode === ecs.NetworkMode.AWS_VPC) {
      this.configureAwsVpcNetworking();
    } else {
      // Either None, Bridge or Host networking. Copy SecurityGroup from ASG.
      this.validateNoNetworkingProps();
      this.connections.addSecurityGroup(...this.props.cluster.connections.securityGroups);
    }

    for (const override of this.props.containerOverrides ?? []) {
      const name = override.containerDefinition.containerName;
      if (!cdk.Token.isUnresolved(name)) {
        const cont = this.props.taskDefinition.findContainer(name);
        if (!cont) {
          throw new ValidationError(`Overrides mention container with name '${name}', but no such container in task definition`, this);
        }
      }
    }

    this.taskPolicies = this.makePolicyStatements();
  }

  /**
   * @internal
   */
  protected _renderTask(topLevelQueryLanguage?: sfn.QueryLanguage): any {
    const queryLanguage = sfn._getActualQueryLanguage(topLevelQueryLanguage, this.props.queryLanguage);
    return {
      Resource: integrationResourceArn('ecs', 'runTask', this.integrationPattern),
      ...this._renderParametersOrArguments({
        Cluster: this.props.cluster.clusterArn,
        TaskDefinition: this.props.revisionNumber === undefined ? this.props.taskDefinition.family : `${this.props.taskDefinition.family}:${this.props.revisionNumber.toString()}`,
        NetworkConfiguration: this.networkConfiguration,
        Overrides: renderOverrides(
          {
            cpu: this.props.cpu,
            memoryMiB: this.props.memoryMiB,
            containerOverrides: this.props.containerOverrides,
          }),
        PropagateTags: this.props.propagatedTagSource,
        ...this.props.launchTarget.bind(this, { taskDefinition: this.props.taskDefinition, cluster: this.props.cluster }).parameters,
        EnableExecuteCommand: this.props.enableExecuteCommand,
      }, queryLanguage),
    };
  }

  private configureAwsVpcNetworking() {
    const subnetSelection = this.props.subnets ??
      { subnetType: this.props.assignPublicIp ? ec2.SubnetType.PUBLIC : ec2.SubnetType.PRIVATE_WITH_EGRESS };

    this.networkConfiguration = {
      AwsvpcConfiguration: {
        AssignPublicIp: this.props.assignPublicIp ? (this.props.assignPublicIp ? 'ENABLED' : 'DISABLED') : undefined,
        Subnets: this.props.cluster.vpc.selectSubnets(subnetSelection).subnetIds,
        SecurityGroups: cdk.Lazy.list({ produce: () => this.securityGroups?.map(sg => sg.securityGroupId) }),
      },
    };

    // Make sure we have a security group if we're using AWSVPC networking
    this.securityGroups = this.props.securityGroups ?? [new ec2.SecurityGroup(this, 'SecurityGroup', { vpc: this.props.cluster.vpc })];
    this.connections.addSecurityGroup(...this.securityGroups);
  }

  private validateNoNetworkingProps() {
    if (this.props.subnets !== undefined || this.props.securityGroups !== undefined) {
      throw new ValidationError(
        `Supplied TaskDefinition must have 'networkMode' of 'AWS_VPC' to use 'vpcSubnets' and 'securityGroup'. Received: ${this.props.taskDefinition.networkMode}`, this,
      );
    }
  }

  private makePolicyStatements(): iam.PolicyStatement[] {
    const stack = cdk.Stack.of(this);

    const policyStatements = [
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [cdk.FeatureFlags.of(this).isEnabled(STEPFUNCTIONS_TASKS_FIX_RUN_ECS_TASK_POLICY) ? this.getTaskDefinitionArn() : this.getTaskDefinitionFamilyArn() + ':*'],
      }),
      new iam.PolicyStatement({
        actions: ['ecs:StopTask', 'ecs:DescribeTasks'],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: this.taskExecutionRoles().map((r) => r.roleArn),
      }),
    ];

    if (this.integrationPattern === sfn.IntegrationPattern.RUN_JOB) {
      policyStatements.push(
        new iam.PolicyStatement({
          actions: ['events:PutTargets', 'events:PutRule', 'events:DescribeRule'],
          resources: [
            stack.formatArn({
              service: 'events',
              resource: 'rule',
              resourceName: 'StepFunctionsGetEventsForECSTaskRule',
            }),
          ],
        }),
      );
    }

    return policyStatements;
  }

  private getTaskDefinitionArn(): string {
    return this.props.taskDefinition.taskDefinitionArn;
  }

  /**
   * Returns the ARN of the task definition family by removing the
   * revision from the task definition ARN
   * Before - arn:aws:ecs:us-west-2:123456789012:task-definition/hello_world:8
   * After - arn:aws:ecs:us-west-2:123456789012:task-definition/hello_world
   */
  private getTaskDefinitionFamilyArn(): string {
    const arnComponents = cdk.Stack.of(this).splitArn(this.props.taskDefinition.taskDefinitionArn, cdk.ArnFormat.SLASH_RESOURCE_NAME);
    let { resourceName } = arnComponents;

    if (resourceName) {
      resourceName = resourceName.split(':')[0];
    }

    return cdk.Stack.of(this).formatArn({
      partition: arnComponents.partition,
      service: arnComponents.service,
      account: arnComponents.account,
      region: arnComponents.region,
      resource: arnComponents.resource,
      arnFormat: arnComponents.arnFormat,
      resourceName,
    });
  }

  private taskExecutionRoles(): iam.IRole[] {
    // Need to be able to pass both Task and Execution role, apparently
    const ret = new Array<iam.IRole>();
    ret.push(this.props.taskDefinition.taskRole);
    if (this.props.taskDefinition.executionRole) {
      ret.push(this.props.taskDefinition.executionRole);
    }
    return ret;
  }
}

interface OverrideProps {
  cpu?: string;
  memoryMiB?: string;
  containerOverrides?: ContainerOverride[];
}

function renderOverrides(props: OverrideProps) {
  const containerOverrides = props.containerOverrides;
  const noContainerOverrides = !containerOverrides || containerOverrides.length === 0;
  if (noContainerOverrides && !props.cpu && !props.memoryMiB) {
    return undefined;
  }

  const ret = new Array<any>();
  if (!noContainerOverrides) {
    for (const override of containerOverrides) {
      ret.push({
        Name: override.containerDefinition.containerName,
        Command: override.command,
        Cpu: override.cpu,
        Memory: override.memoryLimit,
        MemoryReservation: override.memoryReservation,
        Environment:
          override.environment?.map((e) => ({
            Name: e.name,
            Value: e.value,
          })),
      });
    }
  }

  return {
    Cpu: props.cpu,
    Memory: props.memoryMiB,
    ContainerOverrides: noContainerOverrides ? undefined : ret,
  };
}
