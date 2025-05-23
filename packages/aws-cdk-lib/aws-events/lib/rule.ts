import { Node, Construct } from 'constructs';
import { IEventBus } from './event-bus';
import { EventPattern } from './event-pattern';
import { CfnEventBusPolicy, CfnRule } from './events.generated';
import { EventCommonOptions } from './on-event-options';
import { IRule } from './rule-ref';
import { Schedule } from './schedule';
import { IRuleTarget } from './target';
import { mergeEventPattern, renderEventPattern } from './util';
import { IRole, PolicyStatement, Role, ServicePrincipal } from '../../aws-iam';
import { App, IResource, Lazy, Names, Resource, Stack, Token, TokenComparison, PhysicalName, ArnFormat, Annotations, ValidationError } from '../../core';
import { addConstructMetadata, MethodMetadata } from '../../core/lib/metadata-resource';
import { propertyInjectable } from '../../core/lib/prop-injectable';

/**
 * Properties for defining an EventBridge Rule
 */
export interface RuleProps extends EventCommonOptions {
  /**
   * Indicates whether the rule is enabled.
   *
   * @default true
   */
  readonly enabled?: boolean;

  /**
   * The schedule or rate (frequency) that determines when EventBridge
   * runs the rule.
   *
   * You must specify this property, the `eventPattern` property, or both.
   *
   * For more information, see Schedule Expression Syntax for
   * Rules in the Amazon EventBridge User Guide.
   *
   * @see https://docs.aws.amazon.com/eventbridge/latest/userguide/scheduled-events.html
   *
   * @default - None.
   */
  readonly schedule?: Schedule;

  /**
   * Targets to invoke when this rule matches an event.
   *
   * Input will be the full matched event. If you wish to specify custom
   * target input, use `addTarget(target[, inputOptions])`.
   *
   * @default - No targets.
   */
  readonly targets?: IRuleTarget[];

  /**
   * The event bus to associate with this rule.
   *
   * @default - The default event bus.
   */
  readonly eventBus?: IEventBus;

  /**
   * The role that is used for target invocation.
   * Must be assumable by principal `events.amazonaws.com`.
   *
   * @default - No role associated
   */
  readonly role?: IRole;
}

/**
 * Defines an EventBridge Rule in this stack.
 *
 * @resource AWS::Events::Rule
 */
@propertyInjectable
export class Rule extends Resource implements IRule {
  /** Uniquely identifies this class. */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-events.Rule';

  /**
   * Import an existing EventBridge Rule provided an ARN
   *
   * @param scope The parent creating construct (usually `this`).
   * @param id The construct's name.
   * @param eventRuleArn Event Rule ARN (i.e. arn:aws:events:<region>:<account-id>:rule/MyScheduledRule).
   */
  public static fromEventRuleArn(scope: Construct, id: string, eventRuleArn: string): IRule {
    const parts = Stack.of(scope).splitArn(eventRuleArn, ArnFormat.SLASH_RESOURCE_NAME);

    class Import extends Resource implements IRule {
      public ruleArn = eventRuleArn;
      public ruleName = parts.resourceName || '';
    }
    return new Import(scope, id, {
      environmentFromArn: eventRuleArn,
    });
  }

  public readonly ruleArn: string;
  public readonly ruleName: string;

  private readonly targets = new Array<CfnRule.TargetProperty>();
  private readonly eventPattern: EventPattern = { };
  private readonly scheduleExpression?: string;
  private readonly description?: string;

  /** Set to keep track of what target accounts and regions we've already created event buses for */
  private readonly _xEnvTargetsAdded = new Set<string>();

  constructor(scope: Construct, id: string, props: RuleProps = { }) {
    super(determineRuleScope(scope, props), id, {
      physicalName: props.ruleName,
    });
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    if (props.eventBus && props.schedule) {
      throw new ValidationError('Cannot associate rule with \'eventBus\' when using \'schedule\'', this);
    }

    this.description = props.description;
    this.scheduleExpression = props.schedule?.expressionString;

    // add a warning on synth when minute is not defined in a cron schedule
    props.schedule?._bind(this);

    const resource = new CfnRule(this, 'Resource', {
      name: this.physicalName,
      description: this.description,
      state: props.enabled == null ? 'ENABLED' : (props.enabled ? 'ENABLED' : 'DISABLED'),
      scheduleExpression: this.scheduleExpression,
      eventPattern: Lazy.any({ produce: () => this._renderEventPattern() }),
      targets: Lazy.any({ produce: () => this.renderTargets() }),
      eventBusName: props.eventBus && props.eventBus.eventBusName,
      roleArn: props.role?.roleArn,
    });

    this.ruleArn = this.getResourceArnAttribute(resource.attrArn, {
      service: 'events',
      resource: 'rule',
      resourceName: this.physicalName,
    });
    this.ruleName = this.getResourceNameAttribute(resource.ref);

    this.addEventPattern(props.eventPattern);

    for (const target of props.targets || []) {
      this.addTarget(target);
    }

    this.node.addValidation({ validate: () => this.validateRule() });
  }

  /**
   * Adds a target to the rule. The abstract class RuleTarget can be extended to define new
   * targets.
   *
   * No-op if target is undefined.
   */
  @MethodMetadata()
  public addTarget(target?: IRuleTarget): void {
    if (!target) { return; }

    // Simply increment id for each `addTarget` call. This is guaranteed to be unique.
    const autoGeneratedId = `Target${this.targets.length}`;

    const targetProps = target.bind(this, autoGeneratedId);
    const inputProps = targetProps.input && targetProps.input.bind(this);

    const roleArn = targetProps.role?.roleArn;
    const id = targetProps.id || autoGeneratedId;

    if (targetProps.targetResource) {
      const targetStack = Stack.of(targetProps.targetResource);

      const targetAccount = (targetProps.targetResource as IResource).env?.account || targetStack.account;
      const targetRegion = (targetProps.targetResource as IResource).env?.region || targetStack.region;

      const sourceStack = Stack.of(this);
      const sourceAccount = sourceStack.account;
      const sourceRegion = sourceStack.region;

      // if the target is in a different account or region and is defined in this CDK App
      // we can generate all the needed components:
      // - forwarding rule in the source stack (target: default event bus of the receiver region)
      // - eventbus permissions policy (creating an extra stack)
      // - receiver rule in the target stack (target: the actual target)
      if (!this.sameEnvDimension(sourceAccount, targetAccount) || !this.sameEnvDimension(sourceRegion, targetRegion)) {
        // cross-account and/or cross-region event - strap in, this works differently than regular events!
        // based on:
        // https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-cross-account.html

        // for cross-account or cross-region events, we require a concrete target account and region
        if (!targetAccount || Token.isUnresolved(targetAccount)) {
          throw new ValidationError('You need to provide a concrete account for the target stack when using cross-account or cross-region events', this);
        }
        if (!targetRegion || Token.isUnresolved(targetRegion)) {
          throw new ValidationError('You need to provide a concrete region for the target stack when using cross-account or cross-region events', this);
        }
        if (Token.isUnresolved(sourceAccount)) {
          throw new ValidationError('You need to provide a concrete account for the source stack when using cross-account or cross-region events', this);
        }

        // Don't exactly understand why this code was here (seems unlikely this rule would be violated), but
        // let's leave it in nonetheless.
        const sourceApp = this.node.root;
        if (!sourceApp || !App.isApp(sourceApp)) {
          throw new ValidationError('Event stack which uses cross-account or cross-region targets must be part of a CDK app', this);
        }
        const targetApp = Node.of(targetProps.targetResource).root;
        if (!targetApp || !App.isApp(targetApp)) {
          throw new ValidationError('Target stack which uses cross-account or cross-region event targets must be part of a CDK app', this);
        }
        if (sourceApp !== targetApp) {
          throw new ValidationError('Event stack and target stack must belong to the same CDK app', this);
        }

        // The target of this Rule will be the default event bus of the target environment
        this.ensureXEnvTargetEventBus(targetStack, targetAccount, targetRegion, id);

        // The actual rule lives in the target stack. Other than the account, it's identical to this one,
        // but only evaluated at render time (via a special subclass).
        //
        // FIXME: the MirrorRule is a bit silly, forwarding the exact same event to another event bus
        // and trigger on it there (there will be issues with construct references, for example). Especially
        // in the case of scheduled events, we will just trigger both rules in parallel in both environments.
        //
        // A better solution would be to have the source rule add a unique token to the the event,
        // and have the mirror rule trigger on that token only (thereby properly separating triggering, which
        // happens in the source env; and activating, which happens in the target env).
        //
        // Don't have time to do that right now.
        const mirrorRuleScope = this.obtainMirrorRuleScope(targetStack, targetAccount, targetRegion);
        new MirrorRule(mirrorRuleScope, `${Names.uniqueId(this)}-${id}`, {
          targets: [target],
          eventPattern: this.eventPattern,
          schedule: this.scheduleExpression ? Schedule.expression(this.scheduleExpression) : undefined,
          description: this.description,
        }, this);

        return;
      }
    }

    // Here only if the target does not have a targetResource defined.
    // In such case we don't have to generate any extra component.
    // Note that this can also be an imported resource (i.e: EventBus target)

    this.targets.push({
      id,
      arn: targetProps.arn,
      roleArn,
      ecsParameters: targetProps.ecsParameters,
      httpParameters: targetProps.httpParameters,
      kinesisParameters: targetProps.kinesisParameters,
      runCommandParameters: targetProps.runCommandParameters,
      batchParameters: targetProps.batchParameters,
      deadLetterConfig: targetProps.deadLetterConfig,
      retryPolicy: targetProps.retryPolicy,
      sqsParameters: targetProps.sqsParameters,
      redshiftDataParameters: targetProps.redshiftDataParameters,
      appSyncParameters: targetProps.appSyncParameters,
      input: inputProps && inputProps.input,
      inputPath: inputProps && inputProps.inputPath,
      inputTransformer: inputProps?.inputTemplate !== undefined ? {
        inputTemplate: inputProps.inputTemplate,
        inputPathsMap: inputProps.inputPathsMap,
      } : undefined,
    });
  }

  /**
   * Adds an event pattern filter to this rule. If a pattern was already specified,
   * these values are merged into the existing pattern.
   *
   * For example, if the rule already contains the pattern:
   *
   *    {
   *      "resources": [ "r1" ],
   *      "detail": {
   *        "hello": [ 1 ]
   *      }
   *    }
   *
   * And `addEventPattern` is called with the pattern:
   *
   *    {
   *      "resources": [ "r2" ],
   *      "detail": {
   *        "foo": [ "bar" ]
   *      }
   *    }
   *
   * The resulting event pattern will be:
   *
   *    {
   *      "resources": [ "r1", "r2" ],
   *      "detail": {
   *        "hello": [ 1 ],
   *        "foo": [ "bar" ]
   *      }
   *    }
   *
   */
  @MethodMetadata()
  public addEventPattern(eventPattern?: EventPattern) {
    if (!eventPattern) {
      return;
    }
    mergeEventPattern(this.eventPattern, eventPattern);
  }

  /**
   * Not private only to be overrideen in CopyRule.
   *
   * @internal
   */
  public _renderEventPattern(): any {
    return renderEventPattern(this.eventPattern);
  }

  protected validateRule() {
    const errors: string[] = [];

    const name = this.physicalName;
    if (name !== undefined && !Token.isUnresolved(name)) {
      if (name.length < 1 || name.length > 64) {
        errors.push(`Event rule name must be between 1 and 64 characters. Received: ${name}`);
      }
      if (!/^[\.\-_A-Za-z0-9]+$/.test(name)) {
        errors.push(`Event rule name ${name} can contain only letters, numbers, periods, hyphens, or underscores with no spaces.`);
      }
    }

    if (Object.keys(this.eventPattern).length === 0 && !this.scheduleExpression) {
      errors.push('Either \'eventPattern\' or \'schedule\' must be defined');
    }

    if (this.targets.length > 5) {
      errors.push('Event rule cannot have more than 5 targets.');
    }

    return errors;
  }

  private renderTargets() {
    if (this.targets.length === 0) {
      return undefined;
    }

    return this.targets;
  }

  /**
   * Make sure we add the target environments event bus as a target, and the target has permissions set up to receive our events
   *
   * For cross-account rules, uses a support stack to set up a policy on the target event bus.
   */
  private ensureXEnvTargetEventBus(targetStack: Stack, targetAccount: string, targetRegion: string, id: string) {
    // the _actual_ target is just the event bus of the target's account
    // make sure we only add it once per account per region
    const key = `${targetAccount}:${targetRegion}`;
    if (this._xEnvTargetsAdded.has(key)) { return; }
    this._xEnvTargetsAdded.add(key);

    const eventBusArn = targetStack.formatArn({
      service: 'events',
      resource: 'event-bus',
      resourceName: 'default',
      region: targetRegion,
      account: targetAccount,
    });

    // For some reason, cross-region requires a Role (with `PutEvents` on the
    // target event bus) while cross-account doesn't
    const roleArn = !this.sameEnvDimension(targetRegion, Stack.of(this).region)
      ? this.crossRegionPutEventsRole(eventBusArn).roleArn
      : undefined;

    this.targets.push({
      id,
      arn: eventBusArn,
      roleArn,
    });

    // Add a policy to the target Event Bus to allow the source account/region to publish into it.
    //
    // Since this Event Bus permission needs to be deployed before the stack containing the Rule is deployed
    // (as EventBridge verifies whether you have permissions to the targets on rule creation), this needs
    // to be in a support stack.

    const sourceApp = this.node.root as App;
    const sourceAccount = Stack.of(this).account;

    // If different accounts, we need to add the permissions to the target eventbus
    //
    // For different region, no need for a policy on the target event bus (but a need
    // for a role).
    if (!this.sameEnvDimension(sourceAccount, targetAccount)) {
      const stackId = `EventBusPolicy-${sourceAccount}-${targetRegion}-${targetAccount}`;
      let eventBusPolicyStack: Stack = sourceApp.node.tryFindChild(stackId) as Stack;
      if (!eventBusPolicyStack) {
        eventBusPolicyStack = new Stack(sourceApp, stackId, {
          env: {
            account: targetAccount,
            region: targetRegion,
          },
          // The region in the stack name is rather redundant (it will always be the target region)
          // Leaving it in for backwards compatibility.
          stackName: `${targetStack.stackName}-EventBusPolicy-support-${targetRegion}-${sourceAccount}`,
        });
        const statementPrefix = `Allow-account-${sourceAccount}-`;
        new CfnEventBusPolicy(eventBusPolicyStack, 'GivePermToOtherAccount', {
          action: 'events:PutEvents',
          statementId: statementPrefix + Names.uniqueResourceName(this, {
            maxLength: 64 - statementPrefix.length,
          }),
          principal: sourceAccount,
        });
      }
      // deploy the event bus permissions before the source stack
      Stack.of(this).addDependency(eventBusPolicyStack);
    }
  }

  /**
   * Return the scope where the mirror rule should be created for x-env event targets
   *
   * This is the target resource's containing stack if it shares the same region (owned
   * resources), or should be a fresh support stack for imported resources.
   *
   * We don't implement the second yet, as I have to think long and hard on whether we
   * can reuse the existing support stack or not, and I don't have time for that right now.
   */
  private obtainMirrorRuleScope(targetStack: Stack, targetAccount: string, targetRegion: string): Construct {
    // for cross-account or cross-region events, we cannot create new components for an imported resource
    // because we don't have the target stack
    if (this.sameEnvDimension(targetStack.account, targetAccount) && this.sameEnvDimension(targetStack.region, targetRegion)) {
      return targetStack;
    }

    // For now, we don't do the work for the support stack yet
    throw new ValidationError('Cannot create a cross-account or cross-region rule for an imported resource (create a stack with the right environment for the imported resource)', this);
  }

  /**
   * Obtain the Role for the EventBridge event
   *
   * If a role already exists, it will be returned. This ensures that if multiple
   * events have the same target, they will share a role.
   * @internal
   */
  private crossRegionPutEventsRole(eventBusArn: string): IRole {
    const id = 'EventsRole';
    let role = this.node.tryFindChild(id) as IRole;
    if (!role) {
      role = new Role(this, id, {
        roleName: PhysicalName.GENERATE_IF_NEEDED,
        assumedBy: new ServicePrincipal('events.amazonaws.com'),
      });
    }

    role.addToPrincipalPolicy(new PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [eventBusArn],
    }));

    return role;
  }

  /**
   * Whether two string probably contain the same environment dimension (region or account)
   *
   * Used to compare either accounts or regions, and also returns true if one or both
   * are unresolved (in which case both are expected to be "current region" or "current account").
   */
  private sameEnvDimension(dim1: string, dim2: string) {
    switch (Token.compareStrings(dim1, dim2)) {
      case TokenComparison.ONE_UNRESOLVED:
        Annotations.of(this).addWarningV2('@aws-cdk/aws-events:ruleUnresolvedEnvironment', 'Either the Event Rule or target has an unresolved environment. \n \
          If they are being used in a cross-environment setup you need to specify the environment for both.');
        return true;
      case TokenComparison.BOTH_UNRESOLVED:
      case TokenComparison.SAME:
        return true;
      default:
        return false;
    }
  }
}

function determineRuleScope(scope: Construct, props: RuleProps): Construct {
  if (!props.crossStackScope) {
    return scope;
  }
  const scopeStack = Stack.of(scope);
  const targetStack = Stack.of(props.crossStackScope);
  if (scopeStack === targetStack) {
    return scope;
  }
  // cross-region/account Events require their own setup,
  // so we use the base scope in that case
  const regionComparison = Token.compareStrings(scopeStack.region, targetStack.region);
  const accountComparison = Token.compareStrings(scopeStack.account, targetStack.account);
  const stacksInSameAccountAndRegion = (regionComparison === TokenComparison.SAME || regionComparison === TokenComparison.BOTH_UNRESOLVED) &&
    (accountComparison === TokenComparison.SAME || accountComparison === TokenComparison.BOTH_UNRESOLVED);
  return stacksInSameAccountAndRegion ? props.crossStackScope : scope;
}

/**
 * A rule that mirrors another rule
 */
@propertyInjectable
class MirrorRule extends Rule {
  /** Uniquely identifies this class. */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-events.MirrorRule';

  constructor(scope: Construct, id: string, props: RuleProps, private readonly source: Rule) {
    super(scope, id, props);
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);
  }

  public _renderEventPattern(): any {
    return this.source._renderEventPattern();
  }

  /**
   * Override validateRule to be a no-op
   *
   * The rules are never stored on this object so there's nothing to validate.
   *
   * Instead, we mirror the other rule at render time.
   */
  protected validateRule(): string[] {
    return [];
  }
}
