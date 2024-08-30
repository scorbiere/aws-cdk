import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { IntegTest } from '@aws-cdk/integ-tests-alpha';
import { Construct } from 'constructs';
import { STANDARD_NODEJS_RUNTIME } from '../../config';

class TestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const granterFunction = new lambda.Function(this, 'GranterFunction', {
      runtime: STANDARD_NODEJS_RUNTIME,
      handler: 'index.handler',
      code: new lambda.InlineCode('foo'),
    });

    const receiverFunction = new lambda.Function(this, 'ReceiverFunction', {
      runtime: STANDARD_NODEJS_RUNTIME,
      handler: 'index.handler',
      code: new lambda.InlineCode('bar'),
    });

    const arnPrincipal = new iam.ArnPrincipal(receiverFunction.functionArn);
    granterFunction.grantInvokeUrl(arnPrincipal);
  }
}

const app = new cdk.App();
const stack = new TestStack(app, 'LambdaGrantInvokeUrlTest');

new IntegTest(app, 'LambdaGrantInvokeUrlIntegTest', {
  testCases: [stack]
});
