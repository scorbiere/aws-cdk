# Route53 Alias Record Targets for the CDK Route53 Library

This library contains Route53 Alias Record targets for:

- API Gateway custom domains

```ts
import * as apigw from 'aws-cdk-lib/aws-apigateway';

declare const zone: route53.HostedZone;
declare const restApi: apigw.LambdaRestApi;

new route53.ARecord(this, 'AliasRecord', {
  zone,
  target: route53.RecordTarget.fromAlias(new targets.ApiGateway(restApi)),
  // or - route53.RecordTarget.fromAlias(new alias.ApiGatewayDomain(domainName)),
});
```

- API Gateway V2 custom domains

```ts
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';

declare const zone: route53.HostedZone;
declare const domainName: apigwv2.DomainName;

new route53.ARecord(this, 'AliasRecord', {
  zone,
  target: route53.RecordTarget.fromAlias(new targets.ApiGatewayv2DomainProperties(domainName.regionalDomainName, domainName.regionalHostedZoneId)),
});
```

- AppSync custom domains

```ts
import * as appsync from 'aws-cdk-lib/aws-appsync';

declare const zone: route53.HostedZone;
declare const graphqlApi: appsync.GraphqlApi;

new route53.ARecord(this, 'AliasRecord', {
  zone,
  target: route53.RecordTarget.fromAlias(new targets.AppSyncTarget(graphqlApi)),
});
```

- CloudFront distributions

```ts
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

declare const zone: route53.HostedZone;
declare const distribution: cloudfront.CloudFrontWebDistribution;

new route53.ARecord(this, 'AliasRecord', {
  zone,
  target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
});
```

- ELBv2 load balancers

By providing optional properties, you can specify whether to evaluate target health.

```ts
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

declare const zone: route53.HostedZone;
declare const lb: elbv2.ApplicationLoadBalancer;

new route53.ARecord(this, 'AliasRecord', {
  zone,
  target: route53.RecordTarget.fromAlias(
    new targets.LoadBalancerTarget(lb, {
      evaluateTargetHealth: true,
    }),
  ),
});
```

- Classic load balancers

By providing optional properties, you can specify whether to evaluate target health.

```ts
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancing';

declare const zone: route53.HostedZone;
declare const lb: elb.LoadBalancer;

new route53.ARecord(this, 'AliasRecord', {
  zone,
  target: route53.RecordTarget.fromAlias(
    new targets.ClassicLoadBalancerTarget(lb, {
      evaluateTargetHealth: true,
    }),
  ),
});
```

**Important:** Based on [AWS documentation](https://aws.amazon.com/de/premiumsupport/knowledge-center/alias-resource-record-set-route53-cli/), all alias record in Route 53 that points to a Elastic Load Balancer will always include _dualstack_ for the DNSName to resolve IPv4/IPv6 addresses (without _dualstack_ IPv6 will not resolve).

For example, if the Amazon-provided DNS for the load balancer is `ALB-xxxxxxx.us-west-2.elb.amazonaws.com`, CDK will create alias target in Route 53 will be `dualstack.ALB-xxxxxxx.us-west-2.elb.amazonaws.com`.

- GlobalAccelerator

By providing optional properties, you can specify whether to evaluate target health.

```ts
import * as globalaccelerator from 'aws-cdk-lib/aws-globalaccelerator';

declare const zone: route53.HostedZone;
declare const accelerator: globalaccelerator.Accelerator;

new route53.ARecord(this, 'AliasRecord', {
  zone,
  target: route53.RecordTarget.fromAlias(
    new targets.GlobalAcceleratorTarget(accelerator, {
      evaluateTargetHealth: true,
    }),
  ),
  // or
  // route53.RecordTarget.fromAlias(new targets.GlobalAcceleratorDomainTarget('xyz.awsglobalaccelerator.com',{
  //   evaluateTargetHealth: true,
  // })),
});
```

**Important:** If you use GlobalAcceleratorDomainTarget, passing a string rather than an instance of IAccelerator, ensure that the string is a valid domain name of an existing Global Accelerator instance.
See [the documentation on DNS addressing](https://docs.aws.amazon.com/global-accelerator/latest/dg/dns-addressing-custom-domains.dns-addressing.html) with Global Accelerator for more info.

- InterfaceVpcEndpoints

**Important:** Based on the CFN docs for VPCEndpoints - [see here](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpcendpoint.html#aws-resource-ec2-vpcendpoint-return-values) - the attributes returned for DnsEntries in CloudFormation is a combination of the hosted zone ID and the DNS name. The entries are ordered as follows: regional public DNS, zonal public DNS, private DNS, and wildcard DNS. This order is not enforced for AWS Marketplace services, and therefore this CDK construct is ONLY guaranteed to work with non-marketplace services.

```ts
import * as ec2 from 'aws-cdk-lib/aws-ec2';

declare const zone: route53.HostedZone;
declare const interfaceVpcEndpoint: ec2.InterfaceVpcEndpoint;

new route53.ARecord(this, 'AliasRecord', {
  zone,
  target: route53.RecordTarget.fromAlias(new targets.InterfaceVpcEndpointTarget(interfaceVpcEndpoint)),
});
```

- S3 Bucket Website:

**Important:** The Bucket name must strictly match the full DNS name.
See [the Developer Guide](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/getting-started.html) for more info.

By providing optional properties, you can specify whether to evaluate target health.

```ts
import * as s3 from 'aws-cdk-lib/aws-s3';

const recordName = 'www';
const domainName = 'example.com';

const bucketWebsite = new s3.Bucket(this, 'BucketWebsite', {
  bucketName: [recordName, domainName].join('.'), // www.example.com
  publicReadAccess: true,
  websiteIndexDocument: 'index.html',
});

const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName }); // example.com

new route53.ARecord(this, 'AliasRecord', {
  zone,
  recordName, // www
  target: route53.RecordTarget.fromAlias(
    new targets.BucketWebsiteTarget(bucketWebsite, {
      evaluateTargetHealth: true,
    }),
  ),
});
```

- User pool domain

```ts
import * as cognito from 'aws-cdk-lib/aws-cognito';

declare const zone: route53.HostedZone;
declare const domain: cognito.UserPoolDomain;
new route53.ARecord(this, 'AliasRecord', {
  zone,
  target: route53.RecordTarget.fromAlias(new targets.UserPoolDomainTarget(domain)),
});
```

- Route 53 record

```ts
declare const zone: route53.HostedZone;
declare const record: route53.ARecord;
new route53.ARecord(this, 'AliasRecord', {
  zone,
  target: route53.RecordTarget.fromAlias(new targets.Route53RecordTarget(record)),
});
```

- Elastic Beanstalk environment:

**Important:** Only supports Elastic Beanstalk environments created after 2016 that have a regional endpoint.

By providing optional properties, you can specify whether to evaluate target health.

```ts
declare const zone: route53.HostedZone;
declare const ebsEnvironmentUrl: string;

new route53.ARecord(this, 'AliasRecord', {
  zone,
  target: route53.RecordTarget.fromAlias(
    new targets.ElasticBeanstalkEnvironmentEndpointTarget(ebsEnvironmentUrl, {
      evaluateTargetHealth: true,
    }),
  ),
});
```

If Elastic Beanstalk environment URL is not avaiable at synth time, you can specify Hosted Zone ID of the target

```ts
import { RegionInfo } from 'aws-cdk-lib/region-info';

declare const zone: route53.HostedZone;
declare const ebsEnvironmentUrl: string;

new route53.ARecord(this, 'AliasRecord', {
  zone,
  target: route53.RecordTarget.fromAlias(
    new targets.ElasticBeanstalkEnvironmentEndpointTarget(ebsEnvironmentUrl, {
      hostedZoneId: RegionInfo.get('us-east-1').ebsEnvEndpointHostedZoneId,
    }),
  ),
});
```

Or you can specify Stack region for CDK to generate the correct Hosted Zone ID.

```ts
import { App } from 'aws-cdk-lib';

declare const app: App;
declare const zone: route53.HostedZone;
declare const ebsEnvironmentUrl: string;

const stack = new Stack(app, 'my-stack', {
  env: {
    region: 'us-east-1',
  },
});

new route53.ARecord(stack, 'AliasRecord', {
  zone,
  target: route53.RecordTarget.fromAlias(
    new targets.ElasticBeanstalkEnvironmentEndpointTarget(ebsEnvironmentUrl),
  ),
});
```

See the documentation of `aws-cdk-lib/aws-route53` for more information.
