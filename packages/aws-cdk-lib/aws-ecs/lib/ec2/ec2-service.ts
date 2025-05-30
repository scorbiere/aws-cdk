import { Construct } from 'constructs';
import * as ec2 from '../../../aws-ec2';
import * as elb from '../../../aws-elasticloadbalancing';
import { Lazy, Resource, Stack, Annotations, Token, ValidationError } from '../../../core';
import { addConstructMetadata, MethodMetadata } from '../../../core/lib/metadata-resource';
import { propertyInjectable } from '../../../core/lib/prop-injectable';
import { AvailabilityZoneRebalancing } from '../availability-zone-rebalancing';
import { BaseService, BaseServiceOptions, DeploymentControllerType, IBaseService, IService, LaunchType } from '../base/base-service';
import { fromServiceAttributes, extractServiceNameFromArn } from '../base/from-service-attributes';
import { NetworkMode, TaskDefinition } from '../base/task-definition';
import { ICluster } from '../cluster';
import { CfnService } from '../ecs.generated';
import { PlacementConstraint, PlacementStrategy } from '../placement';

/**
 * The properties for defining a service using the EC2 launch type.
 */
export interface Ec2ServiceProps extends BaseServiceOptions {
  /**
   * The task definition to use for tasks in the service.
   *
   * [disable-awslint:ref-via-interface]
   */
  readonly taskDefinition: TaskDefinition;

  /**
   * Specifies whether the task's elastic network interface receives a public IP address.
   * If true, each task will receive a public IP address.
   *
   * This property is only used for tasks that use the awsvpc network mode.
   *
   * @default false
   */
  readonly assignPublicIp?: boolean;

  /**
   * The subnets to associate with the service.
   *
   * This property is only used for tasks that use the awsvpc network mode.
   *
   * @default - Public subnets if `assignPublicIp` is set, otherwise the first available one of Private, Isolated, Public, in that order.
   */
  readonly vpcSubnets?: ec2.SubnetSelection;

  /**
   * The security groups to associate with the service. If you do not specify a security group, a new security group is created.
   *
   * This property is only used for tasks that use the awsvpc network mode.
   *
   * @default - A new security group is created.
   * @deprecated use securityGroups instead.
   */
  readonly securityGroup?: ec2.ISecurityGroup;

  /**
   * The security groups to associate with the service. If you do not specify a security group, a new security group is created.
   *
   * This property is only used for tasks that use the awsvpc network mode.
   *
   * @default - A new security group is created.
   */
  readonly securityGroups?: ec2.ISecurityGroup[];

  /**
   * The placement constraints to use for tasks in the service. For more information, see
   * [Amazon ECS Task Placement Constraints](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-placement-constraints.html).
   *
   * @default - No constraints.
   */
  readonly placementConstraints?: PlacementConstraint[];

  /**
   * The placement strategies to use for tasks in the service. For more information, see
   * [Amazon ECS Task Placement Strategies](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-placement-strategies.html).
   *
   * @default - No strategies.
   */
  readonly placementStrategies?: PlacementStrategy[];

  /**
   * Specifies whether the service will use the daemon scheduling strategy.
   * If true, the service scheduler deploys exactly one task on each container instance in your cluster.
   *
   * When you are using this strategy, do not specify a desired number of tasks or any task placement strategies.
   *
   * @default false
   */
  readonly daemon?: boolean;

  /**
   * Whether to use Availability Zone rebalancing for the service.
   *
   * If enabled: `maxHealthyPercent` must be greater than 100; `daemon` must be false; if there
   * are any `placementStrategies`, the first must be "spread across Availability Zones"; there
   * must be no `placementConstraints` using `attribute:ecs.availability-zone`, and the
   * service must not be a target of a Classic Load Balancer.
   *
   * @see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-rebalancing.html
   * @default AvailabilityZoneRebalancing.DISABLED
   */
  readonly availabilityZoneRebalancing?: AvailabilityZoneRebalancing;
}

/**
 * The interface for a service using the EC2 launch type on an ECS cluster.
 */
export interface IEc2Service extends IService {

}

/**
 * The properties to import from the service using the EC2 launch type.
 */
export interface Ec2ServiceAttributes {
  /**
   * The cluster that hosts the service.
   */
  readonly cluster: ICluster;

  /**
   * The service ARN.
   *
   * @default - either this, or `serviceName`, is required
   */
  readonly serviceArn?: string;

  /**
   * The name of the service.
   *
   * @default - either this, or `serviceArn`, is required
   */
  readonly serviceName?: string;
}

/**
 * This creates a service using the EC2 launch type on an ECS cluster.
 *
 * @resource AWS::ECS::Service
 */
@propertyInjectable
export class Ec2Service extends BaseService implements IEc2Service {
  /**
   * Uniquely identifies this class.
   */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-ecs.Ec2Service';

  /**
   * Imports from the specified service ARN.
   */
  public static fromEc2ServiceArn(scope: Construct, id: string, ec2ServiceArn: string): IEc2Service {
    class Import extends Resource implements IEc2Service {
      public readonly serviceArn = ec2ServiceArn;
      public readonly serviceName = extractServiceNameFromArn(this, ec2ServiceArn);
    }
    return new Import(scope, id);
  }

  /**
   * Imports from the specified service attributes.
   */
  public static fromEc2ServiceAttributes(scope: Construct, id: string, attrs: Ec2ServiceAttributes): IBaseService {
    return fromServiceAttributes(scope, id, attrs);
  }

  private constraints?: CfnService.PlacementConstraintProperty[];
  private readonly strategies: CfnService.PlacementStrategyProperty[];
  private readonly daemon: boolean;
  private readonly availabilityZoneRebalancingEnabled: boolean;

  /**
   * Constructs a new instance of the Ec2Service class.
   */
  constructor(scope: Construct, id: string, props: Ec2ServiceProps) {
    if (props.daemon && props.desiredCount !== undefined) {
      throw new ValidationError('Daemon mode launches one task on every instance. Don\'t supply desiredCount.', scope);
    }

    if (props.daemon && props.maxHealthyPercent !== undefined && props.maxHealthyPercent !== 100) {
      throw new ValidationError('Maximum percent must be 100 for daemon mode.', scope);
    }

    if (props.minHealthyPercent !== undefined && props.maxHealthyPercent !== undefined && props.minHealthyPercent >= props.maxHealthyPercent) {
      throw new ValidationError('Minimum healthy percent must be less than maximum healthy percent.', scope);
    }

    if (!props.taskDefinition.isEc2Compatible) {
      throw new ValidationError('Supplied TaskDefinition is not configured for compatibility with EC2', scope);
    }

    if (props.securityGroup !== undefined && props.securityGroups !== undefined) {
      throw new ValidationError('Only one of SecurityGroup or SecurityGroups can be populated.', scope);
    }

    if (props.availabilityZoneRebalancing === AvailabilityZoneRebalancing.ENABLED) {
      if (props.daemon) {
        throw new ValidationError('AvailabilityZoneRebalancing.ENABLED cannot be used with daemon mode', scope);
      }
      if (!Token.isUnresolved(props.maxHealthyPercent) && props.maxHealthyPercent === 100) {
        throw new ValidationError('AvailabilityZoneRebalancing.ENABLED requires maxHealthyPercent > 100', scope);
      }
    }

    super(scope, id, {
      ...props,
      desiredCount: props.desiredCount,
      maxHealthyPercent: props.daemon && props.maxHealthyPercent === undefined ? 100 : props.maxHealthyPercent,
      minHealthyPercent: props.daemon && props.minHealthyPercent === undefined ? 0 : props.minHealthyPercent,
      launchType: LaunchType.EC2,
      enableECSManagedTags: props.enableECSManagedTags,
    },
    {
      cluster: props.cluster.clusterName,
      taskDefinition: props.deploymentController?.type === DeploymentControllerType.EXTERNAL ? undefined : props.taskDefinition.taskDefinitionArn,
      placementConstraints: Lazy.any({ produce: () => this.constraints }),
      placementStrategies: Lazy.any({ produce: () => this.strategies }, { omitEmptyArray: true }),
      schedulingStrategy: props.daemon ? 'DAEMON' : 'REPLICA',
      availabilityZoneRebalancing: props.availabilityZoneRebalancing,
    }, props.taskDefinition);
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    this.constraints = undefined;
    this.strategies = [];
    this.daemon = props.daemon || false;
    this.availabilityZoneRebalancingEnabled = props.availabilityZoneRebalancing === AvailabilityZoneRebalancing.ENABLED;

    let securityGroups;
    if (props.securityGroup !== undefined) {
      securityGroups = [props.securityGroup];
    } else if (props.securityGroups !== undefined) {
      securityGroups = props.securityGroups;
    }

    if (props.taskDefinition.networkMode === NetworkMode.AWS_VPC) {
      this.configureAwsVpcNetworkingWithSecurityGroups(props.cluster.vpc, props.assignPublicIp, props.vpcSubnets, securityGroups);
    } else {
      // Either None, Bridge or Host networking. Copy SecurityGroups from ASG.
      // We have to be smart here -- by default future Security Group rules would be created
      // in the Cluster stack. However, if the Cluster is in a different stack than us,
      // that will lead to a cyclic reference (we point to that stack for the cluster name,
      // but that stack will point to the ALB probably created right next to us).
      //
      // In that case, reference the same security groups but make sure new rules are
      // created in the current scope (i.e., this stack)
      validateNoNetworkingProps(scope, props);
      this.connections.addSecurityGroup(...securityGroupsInThisStack(this, props.cluster.connections.securityGroups));
    }

    if (props.placementConstraints) {
      this.addPlacementConstraints(...props.placementConstraints);
    }
    this.addPlacementStrategies(...props.placementStrategies || []);

    this.node.addValidation({
      validate: () => !this.taskDefinition.defaultContainer ? ['A TaskDefinition must have at least one essential container'] : [],
    });

    this.node.addValidation({ validate: this.validateEc2Service.bind(this) });

    if (props.minHealthyPercent === undefined && props.daemon) {
      Annotations.of(this).addWarningV2('@aws-cdk/aws-ecs:minHealthyPercentDaemon', 'minHealthyPercent has not been configured so the default value of 0% for a daemon service is used. See https://github.com/aws/aws-cdk/issues/31705');
    }
  }

  /**
   * Adds one or more placement strategies to use for tasks in the service. For more information, see
   * [Amazon ECS Task Placement Strategies](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-placement-strategies.html).
   */
  @MethodMetadata()
  public addPlacementStrategies(...strategies: PlacementStrategy[]) {
    if (strategies.length > 0 && this.daemon) {
      throw new ValidationError("Can't configure placement strategies when daemon=true", this);
    }

    if (strategies.length > 0 && this.strategies.length === 0 && this.availabilityZoneRebalancingEnabled) {
      const [placement] = strategies[0].toJson();
      if (placement.type !== 'spread' || placement.field !== BuiltInAttributes.AVAILABILITY_ZONE) {
        throw new ValidationError(`AvailabilityZoneBalancing.ENABLED requires that the first placement strategy, if any, be 'spread across "${BuiltInAttributes.AVAILABILITY_ZONE}"'`, this);
      }
    }

    for (const strategy of strategies) {
      this.strategies.push(...strategy.toJson());
    }
  }

  /**
   * Adds one or more placement constraints to use for tasks in the service. For more information, see
   * [Amazon ECS Task Placement Constraints](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-placement-constraints.html).
   */
  @MethodMetadata()
  public addPlacementConstraints(...constraints: PlacementConstraint[]) {
    this.constraints = [];
    for (const constraint of constraints) {
      const items = constraint.toJson();
      if (this.availabilityZoneRebalancingEnabled) {
        for (const item of items) {
          if (item.type === 'memberOf' && item.expression?.includes(BuiltInAttributes.AVAILABILITY_ZONE)) {
            throw new ValidationError(`AvailabilityZoneBalancing.ENABLED disallows usage of "${BuiltInAttributes.AVAILABILITY_ZONE}"`, this);
          }
        }
      }
      this.constraints.push(...items);
    }
  }

  /**
   * Validates this Ec2Service.
   */
  private validateEc2Service(): string[] {
    const ret = new Array<string>();
    if (!this.daemon && !this.cluster.hasEc2Capacity) {
      ret.push('Cluster for this service needs Ec2 capacity. Call addXxxCapacity() on the cluster.');
    }
    return ret;
  }

  /**
   * Registers the service as a target of a Classic Load Balancer (CLB).
   *
   * Don't call this. Call `loadBalancer.addTarget()` instead.
   *
   * @override
   */
  @MethodMetadata()
  public attachToClassicLB(loadBalancer: elb.LoadBalancer): void {
    if (this.availabilityZoneRebalancingEnabled) {
      throw new ValidationError('AvailabilityZoneRebalancing.ENABLED disallows using the service as a target of a Classic Load Balancer', this);
    }
    super.attachToClassicLB(loadBalancer);
  }
}

/**
 * Validate combinations of networking arguments.
 */
function validateNoNetworkingProps(scope: Construct, props: Ec2ServiceProps) {
  if (props.vpcSubnets !== undefined
    || props.securityGroup !== undefined
    || props.securityGroups !== undefined
    || props.assignPublicIp) {
    throw new ValidationError('vpcSubnets, securityGroup(s) and assignPublicIp can only be used in AwsVpc networking mode', scope);
  }
}

/**
 * Force security group rules to be created in this stack.
 *
 * For every security group, if the scope and the group are in different stacks, return
 * a fake "imported" security group instead. This will behave as the original security group,
 * but new Ingress and Egress rule resources will be added in the current stack instead of the
 * other one.
 */
function securityGroupsInThisStack(scope: Construct, groups: ec2.ISecurityGroup[]): ec2.ISecurityGroup[] {
  const thisStack = Stack.of(scope);

  let i = 1;
  return groups.map(group => {
    if (thisStack === Stack.of(group)) { return group; } // Simple case, just return the original one

    return ec2.SecurityGroup.fromSecurityGroupId(scope, `SecurityGroup${i++}`, group.securityGroupId, {
      allowAllOutbound: group.allowAllOutbound,
      mutable: true,
    });
  });
}

/**
 * The built-in container instance attributes
 */
export class BuiltInAttributes {
  /**
   * The id of the instance.
   */
  public static readonly INSTANCE_ID = 'instanceId';

  /**
   * The AvailabilityZone where the instance is running in.
   */
  public static readonly AVAILABILITY_ZONE = 'attribute:ecs.availability-zone';

  /**
   * The AMI id the instance is using.
   */
  public static readonly AMI_ID = 'attribute:ecs.ami-id';

  /**
   * The EC2 instance type.
   */
  public static readonly INSTANCE_TYPE = 'attribute:ecs.instance-type';

  /**
   * The operating system of the instance.
   *
   * Either 'linux' or 'windows'.
   */
  public static readonly OS_TYPE = 'attribute:ecs.os-type';
}
