import { CfnVPC, CfnVPCCidrBlock, DefaultInstanceTenancy, ISubnet, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Arn, CfnResource, FeatureFlags, Lazy, Names, Resource, Tags } from 'aws-cdk-lib/core';
import { Construct, DependencyGroup, IDependable } from 'constructs';
import { IpamOptions, IIpamPool } from './ipam';
import { IVpcV2, VpcV2Base } from './vpc-v2-base';
import { ISubnetV2, SubnetV2, SubnetV2Attributes } from './subnet-v2';
import { cx_api, region_info } from 'aws-cdk-lib';
import { addConstructMetadata } from 'aws-cdk-lib/core/lib/metadata-resource';
import { propertyInjectable } from 'aws-cdk-lib/core/lib/prop-injectable';

/**
 * Additional props needed for secondary Address
 */
export interface SecondaryAddressProps {
  /**
   * Required to set Secondary cidr block resource name
   * in order to generate unique logical id for the resource.
   */
  readonly cidrBlockName: string;
}

/**
 * Additional props needed for BYOIP IPv6 address props
 */
export interface Ipv6PoolSecondaryAddressProps extends SecondaryAddressProps {
  /**
   * ID of the IPv6 address pool from which to allocate the IPv6 CIDR block.
   * Note: BYOIP Pool ID is different from the IPAM Pool ID.
   * To onboard your IPv6 address range to your AWS account please refer to the below documentation
   * @see https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/byoip-onboard.html
   */
  readonly ipv6PoolId: string;

  /**
   * A valid IPv6 CIDR block from the IPv6 address pool onboarded to AWS using BYOIP.
   * The most specific IPv6 address range that you can bring is /48 for CIDRs that are publicly advertisable
   * and /56 for CIDRs that are not publicly advertisable.
   * @see https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-byoip.html#byoip-definitions
   */
  readonly ipv6CidrBlock: string;
}

/**
 * IpAddress options to define VPC V2
 */
export class IpAddresses {
  /**
   * An IPv4 CIDR Range
   */
  public static ipv4(ipv4Cidr: string, props?: SecondaryAddressProps): IIpAddresses {
    return new ipv4CidrAllocation(ipv4Cidr, props);
  }

  /**
   * An Ipv4 Ipam Pool
   */
  public static ipv4Ipam(ipv4IpamOptions: IpamOptions): IIpAddresses {
    return new IpamIpv4(ipv4IpamOptions);
  }

  /**
   * An Ipv6 Ipam Pool
   */
  public static ipv6Ipam(ipv6IpamOptions: IpamOptions): IIpAddresses {
    return new IpamIpv6(ipv6IpamOptions);
  }

  /**
   * Amazon Provided Ipv6 range
   */
  public static amazonProvidedIpv6(props: SecondaryAddressProps) : IIpAddresses {
    return new AmazonProvided(props);
  }

  /**
   * A BYOIP IPv6 address pool
   */
  public static ipv6ByoipPool(props: Ipv6PoolSecondaryAddressProps): IIpAddresses {
    return new Ipv6Pool(props);
  }
}

/**
 * Consolidated return parameters to pass to VPC construct
 */
export interface VpcCidrOptions {

  /**
   * IPv4 CIDR Block
   *
   * @default '10.0.0.0/16'
   */
  readonly ipv4CidrBlock?: string;

  /**
   * CIDR Mask for Vpc
   *
   * @default - Only required when using IPAM Ipv4
   */
  readonly ipv4NetmaskLength?: number;

  /**
   * Ipv4 IPAM Pool
   *
   * @default - Only required when using IPAM Ipv4
   */
  readonly ipv4IpamPool?: IIpamPool;

  /**
   * CIDR Mask for Vpc
   *
   * @default - Only required when using AWS Ipam
   */
  readonly ipv6NetmaskLength?: number;

  /**
   * Ipv6 IPAM pool id for VPC range, can only be defined
   * under public scope
   *
   * @default - no pool id
   */
  readonly ipv6IpamPool?: IIpamPool;

  /**
   * Use amazon provided IP range
   *
   * @default false
   */
  readonly amazonProvided?: boolean;

  /**
   * Dependency to associate Ipv6 CIDR block
   *
   * @default - No dependency
   */
  readonly dependencies?: CfnResource[];

  /**
   * Required to set Secondary cidr block resource name
   * in order to generate unique logical id for the resource.
   *
   * @default - no name for primary addresses
   */
  readonly cidrBlockName?: string;

  /**
   * IPv4 CIDR provisioned under pool
   * Required to check for overlapping CIDRs after provisioning
   * is complete under IPAM pool
   * @default - no IPAM IPv4 CIDR range is provisioned using IPAM
   */
  readonly ipv4IpamProvisionedCidrs?: string[];

  /**
   * IPv6 CIDR block from the BOYIP IPv6 address pool.
   *
   * @default - None
   */
  readonly ipv6CidrBlock?: string;

  /**
   * ID of the BYOIP IPv6 address pool from which to allocate the IPv6 CIDR block.
   *
   * @default - None
   */
  readonly ipv6PoolId?: string;
}

/**
 * Implements ip address allocation according to the IPAdress type
 */
export interface IIpAddresses {

  /**
   * Method to define the implementation logic of
   * IP address allocation
   */
  allocateVpcCidr() : VpcCidrOptions;

}

/**
 * Name tag constant
 */
const NAME_TAG: string = 'Name';

/**
 * Properties to define VPC
 * [disable-awslint:from-method]
 */
export interface VpcV2Props {

  /** A must IPv4 CIDR block for the VPC
   * @see https://docs.aws.amazon.com/vpc/latest/userguide/vpc-cidr-blocks.html
   *
   * @default - Ipv4 CIDR Block ('10.0.0.0/16')
   */
  readonly primaryAddressBlock?: IIpAddresses;

  /**
   * The secondary CIDR blocks associated with the VPC.
   * Can be  IPv4 or IPv6, two IPv4 ranges must follow RFC#1918 convention
   * For more information, @see https://docs.aws.amazon.com/vpc/latest/userguide/vpc-cidr-blocks.html#vpc-resize}.
   *
   * @default - No secondary IP address
   */
  readonly secondaryAddressBlocks?: IIpAddresses[];

  /**
   * Indicates whether the instances launched in the VPC get DNS hostnames.
   *
   * @default true
   */
  readonly enableDnsHostnames?: boolean;

  /**
   * Indicates whether the DNS resolution is supported for the VPC.
   *
   * @default true
   */
  readonly enableDnsSupport?: boolean;

  /**
   * The default tenancy of instances launched into the VPC.
   *
   * By setting this to dedicated tenancy, instances will be launched on
   * hardware dedicated to a single AWS customer, unless specifically specified
   * at instance launch time. Please note, not all instance types are usable
   * with Dedicated tenancy.
   *
   * @default DefaultInstanceTenancy.Default (shared) tenancy
   */
  readonly defaultInstanceTenancy?: DefaultInstanceTenancy;

  /**
   * Physical name for the VPC
   *
   * @default - autogenerated by CDK
   */
  readonly vpcName?: string;
}

/**
 * Options to import a VPC created outside of CDK stack
 */
export interface VpcV2Attributes {

  /**
   * The VPC ID
   * Refers to physical Id of the resource
   */
  readonly vpcId: string;

  /**
   * Region in which imported VPC is hosted
   * required in case of cross region VPC
   * as given value will be used to set field region for imported VPC,
   * which then later can be used for establishing VPC peering connection.
   *
   * @default - constructed with stack region value
   */
  readonly region?: string;

  /**
   * The ID of the AWS account that owns the imported VPC
   * required in case of cross account VPC
   * as given value will be used to set field account for imported VPC,
   * which then later can be used for establishing VPC peering connection.
   *
   * @default - constructed with stack account value
   */
  readonly ownerAccountId?: string;

  /**
   * Primary VPC CIDR Block of the imported VPC
   * Can only be IPv4
   */
  readonly vpcCidrBlock: string;

  /**
   * A VPN Gateway is attached to the VPC
   *
   * @default - No VPN Gateway
   */
  readonly vpnGatewayId?: string;

  /**
   * Subnets associated with imported VPC
   *
   * @default - no subnets provided to be imported
   */
  readonly subnets?: SubnetV2Attributes[];

  /**
   * Import Secondary CIDR blocks associated with VPC
   *
   * @default - No secondary IP address
   */
  readonly secondaryCidrBlocks?: VPCCidrBlockattributes[];
}

/**
 * This class provides a foundation for creating and configuring a VPC with advanced features such as IPAM (IP Address Management) and IPv6 support.
 *
 * For more information, see the {@link https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.Vpc.html|AWS CDK Documentation on VPCs}.
 *
 * @resource AWS::EC2::VPC
 */
@propertyInjectable
export class VpcV2 extends VpcV2Base {
  /** Uniquely identifies this class. */
  public static readonly PROPERTY_INJECTION_ID: string = '@aws-cdk.aws-ec2-alpha.VpcV2';

  /**
   * Create a VPC from existing attributes
   */
  public static fromVpcV2Attributes(scope: Construct, id: string, attrs: VpcV2Attributes): IVpcV2 {
    /**
     * Internal class to allow users to import VPC
     * @internal
     */
    class ImportedVpcV2 extends VpcV2Base {
      public readonly vpcId: string;
      public readonly vpcArn: string;
      public readonly publicSubnets: ISubnetV2[] = [];
      public readonly privateSubnets: ISubnetV2[] = [];
      public readonly isolatedSubnets: ISubnetV2[] = [];
      public readonly internetConnectivityEstablished: IDependable = new DependencyGroup();
      public readonly ipv4CidrBlock: string;
      public readonly region: string;
      public readonly ownerAccountId: string;
      public readonly vpcName?: string;
      private readonly _partition?: string;

      /*
      * Reference to all secondary blocks attached
      */
      public readonly secondaryCidrBlock?: IVPCCidrBlock[];

      /**
       * Refers to actual VPC Resource attribute in non-imported VPC
       * Required to implement here due to extension from Base class
       */
      public readonly vpcCidrBlock: string;

      // Required to do CIDR range test on imported VPCs to create new subnets
      public readonly ipv4IpamProvisionedCidrs: string[] = [];

      constructor(construct: Construct, constructId: string, props: VpcV2Attributes) {
        super(construct, constructId);
        this.vpcId = props.vpcId,
        this.region = props.region ?? this.stack.region,
        this.ownerAccountId = props.ownerAccountId ?? this.stack.account,
        this._partition = region_info.RegionInfo.get(this.region).partition,
        this.vpcArn = Arn.format({
          service: 'ec2',
          resource: 'vpc',
          resourceName: this.vpcId,
          region: this.region,
          account: this.ownerAccountId,
          partition: this._partition,
        }, this.stack);

        // Populate region and account fields that can be used to set up peering connection
        // sample vpc Arn - arn:aws:ec2:us-west-2:123456789012:vpc/vpc-0123456789abcdef0
        this.region = this.vpcArn.split(':')[3];
        this.ownerAccountId = this.vpcArn.split(':')[4];
        // Refers to actual VPC Resource attribute in non-imported VPC
        this.vpcCidrBlock = props.vpcCidrBlock;
        // Required for subnet range related checks
        this.ipv4CidrBlock = props.vpcCidrBlock;
        this._vpnGatewayId = props.vpnGatewayId;

        if (props.subnets) {
          for (const subnet of props.subnets) {
            if (subnet.subnetType === SubnetType.PRIVATE_WITH_EGRESS || subnet.subnetType === SubnetType.PRIVATE_WITH_NAT ||
              subnet.subnetType as string === 'Deprecated_Private') {
              this.privateSubnets.push(SubnetV2.fromSubnetV2Attributes(scope, subnet.subnetName?? 'ImportedPrivateSubnet', subnet));
            } else if (subnet.subnetType === SubnetType.PUBLIC) {
              this.publicSubnets.push(SubnetV2.fromSubnetV2Attributes(scope, subnet.subnetName?? 'ImportedPublicSubnet', subnet));
            } else if (subnet.subnetType as string === 'Deprecated_Isolated' || subnet.subnetType === SubnetType.PRIVATE_ISOLATED) {
              this.isolatedSubnets.push(SubnetV2.fromSubnetV2Attributes(scope, subnet.subnetName?? 'ImportedIsolatedSubnet', subnet));
            }
          }
        }
        this.secondaryCidrBlock = props.secondaryCidrBlocks?.map(cidrBlock => VPCCidrBlock.fromVPCCidrBlockattributes(scope, cidrBlock.cidrBlockName ?? 'ImportedSecondaryCidrBlock', { ...cidrBlock }));
        if (props.secondaryCidrBlocks) {
          for (const cidrBlock of props.secondaryCidrBlocks) {
            if (cidrBlock.ipv4IpamProvisionedCidrs) {
              this.ipv4IpamProvisionedCidrs.push(...cidrBlock.ipv4IpamProvisionedCidrs);
            }
          }
        }
      }
    }
    return new ImportedVpcV2(scope, id, attrs);
  }

  /**
   * Identifier for this VPC
   */
  public readonly vpcId: string;

  /**
   * @attribute
   */
  public readonly vpcArn: string;

  /**
   * @attribute
   */
  public readonly vpcCidrBlock: string;
  /**
   * The IPv6 CIDR blocks for the VPC.
   *
   * See https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpc.html#aws-resource-ec2-vpc-return-values
   */
  public readonly ipv6CidrBlocks: string[];

  /**
   * The provider of ipv4 addresses
   */
  public readonly ipAddresses: IIpAddresses;

  /**
   * The AWS CloudFormation resource representing the VPC.
   */
  public readonly resource: CfnVPC;

  /**
   * Indicates if instances launched in this VPC will have public DNS hostnames.
   */
  public readonly dnsHostnamesEnabled: boolean;

  /**
   * Indicates if DNS support is enabled for this VPC.
   */
  public readonly dnsSupportEnabled: boolean;

  /**
   * Isolated Subnets that are part of this VPC.
   */
  public readonly isolatedSubnets: ISubnet[];

  /**
   * Public Subnets that are part of this VPC.
   */
  public readonly publicSubnets: ISubnet[];

  /**
   * Public Subnets that are part of this VPC.
   */
  public readonly privateSubnets: ISubnet[];

  /**
   * To define dependency on internet connectivity
   */
  public readonly internetConnectivityEstablished: IDependable;

  /**
   * reference to all secondary blocks attached
   */
  public readonly secondaryCidrBlock?: IVPCCidrBlock[] = new Array<IVPCCidrBlock>;

  /**
   * IPv4 CIDR provisioned using IPAM pool
   * Required to check for overlapping CIDRs after provisioning
   * is complete under IPAM
   */
  public readonly ipv4IpamProvisionedCidrs?: string[];

  /**
   * Region for this VPC
   */
  public readonly region: string;

  /**
   * Identifier of the owner for this VPC
   */
  public readonly ownerAccountId: string;

  /**
   * For validation to define IPv6 subnets, set to true in case of
   * Amazon Provided IPv6 cidr range
   * if true, IPv6 addresses can be attached to the subnets.
   *
   * @default false
   */
  public readonly useIpv6: boolean = false;

  /**
   * VpcName to be used for tagging its components
   * @attribute
   */
  public readonly vpcName?: string;

  public readonly ipv4CidrBlock: string = '';

  constructor(scope: Construct, id: string, props: VpcV2Props = {}) {
    super(scope, id, {
      physicalName: props.vpcName ?? Lazy.string({
        produce: () => Names.uniqueResourceName(this, { maxLength: 128, allowedSpecialCharacters: '_' }),
      }),
    });
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);
    this.vpcName = props.vpcName;
    this.ipAddresses = props.primaryAddressBlock ?? IpAddresses.ipv4('10.0.0.0/16');
    const vpcOptions = this.ipAddresses.allocateVpcCidr();

    this.dnsHostnamesEnabled = props.enableDnsHostnames == null ? true : props.enableDnsHostnames;
    this.dnsSupportEnabled = props.enableDnsSupport == null ? true : props.enableDnsSupport;
    const instanceTenancy = props.defaultInstanceTenancy || 'default';
    this.resource = new CfnVPC(this, 'Resource', {
      cidrBlock: vpcOptions.ipv4CidrBlock, // for Ipv4 addresses CIDR block
      enableDnsHostnames: this.dnsHostnamesEnabled,
      enableDnsSupport: this.dnsSupportEnabled,
      ipv4IpamPoolId: vpcOptions.ipv4IpamPool?.ipamPoolId, // for Ipv4 ipam option
      ipv4NetmaskLength: vpcOptions.ipv4NetmaskLength, // for Ipv4 ipam option
      instanceTenancy: instanceTenancy,
    });

    this.node.defaultChild = this.resource;
    this.vpcCidrBlock = this.resource.attrCidrBlock;
    if (vpcOptions.ipv4CidrBlock) {
      this.ipv4CidrBlock = vpcOptions.ipv4CidrBlock;
    }
    this.ipv6CidrBlocks = this.resource.attrIpv6CidrBlocks;
    this.vpcId = FeatureFlags.of(this).isEnabled(cx_api.USE_RESOURCEID_FOR_VPCV2_MIGRATION) ?
      this.resource.ref : this.resource.attrVpcId;
    this.vpcArn = Arn.format({
      service: 'ec2',
      resource: 'vpc',
      resourceName: this.vpcId,
    }, this.stack);
    this.region = this.stack.region;
    this.ownerAccountId = this.stack.account;
    // Add tag to the VPC with the name provided in properties
    Tags.of(this).add(NAME_TAG, props.vpcName || this.node.path);
    if (props.secondaryAddressBlocks) {
      const secondaryAddressBlocks: IIpAddresses[] = props.secondaryAddressBlocks;

      for (const secondaryAddressBlock of secondaryAddressBlocks) {
        const secondaryVpcOptions: VpcCidrOptions = secondaryAddressBlock.allocateVpcCidr();
        if (!secondaryVpcOptions.cidrBlockName) {
          throw new Error('Cidr Block Name is required to create secondary IP address');
        }

        if (secondaryVpcOptions.amazonProvided || secondaryVpcOptions.ipv6IpamPool || secondaryVpcOptions.ipv6PoolId) {
          this.useIpv6 = true;
        }
        // validate CIDR ranges per RFC 1918
        if (secondaryVpcOptions.ipv4CidrBlock!) {
          const ret = validateIpv4address(secondaryVpcOptions.ipv4CidrBlock, this.resource.cidrBlock);
          if (ret === false) {
            throw new Error('CIDR block should be in the same RFC 1918 range in the VPC');
          }
        }
        if (secondaryVpcOptions.ipv4IpamProvisionedCidrs!) {
          this.ipv4IpamProvisionedCidrs?.push(...secondaryVpcOptions.ipv4IpamProvisionedCidrs);
        }
        const vpcCidrBlock = new VPCCidrBlock(this, secondaryVpcOptions.cidrBlockName, {
          vpcId: this.vpcId,
          cidrBlock: secondaryVpcOptions.ipv4CidrBlock,
          ipv4IpamPoolId: secondaryVpcOptions.ipv4IpamPool?.ipamPoolId,
          ipv4NetmaskLength: secondaryVpcOptions.ipv4NetmaskLength,
          ipv6NetmaskLength: secondaryVpcOptions.ipv6NetmaskLength,
          ipv6IpamPoolId: secondaryVpcOptions.ipv6IpamPool?.ipamPoolId,
          amazonProvidedIpv6CidrBlock: secondaryVpcOptions.amazonProvided,
          // BYOIP IPv6 Address
          ipv6CidrBlock: secondaryVpcOptions?.ipv6CidrBlock,
          // BYOIP Pool for IPv6 address
          ipv6Pool: secondaryVpcOptions?.ipv6PoolId,
        });
        if (secondaryVpcOptions.dependencies) {
          for (const dep of secondaryVpcOptions.dependencies) {
            vpcCidrBlock.node.addDependency(dep);
          }
        }
        // Create secondary blocks for Ipv4 and Ipv6
        this.secondaryCidrBlock?.push(vpcCidrBlock);
      }
    }

    /**
     * Empty array for isolated subnets
     */
    this.isolatedSubnets = new Array<ISubnet>;

    /**
     * Empty array for public subnets
     */
    this.publicSubnets = new Array<ISubnet>;

    /**
     * Empty array for private subnets
     */
    this.privateSubnets = new Array<ISubnet>;

    /**
     * Dependable that can be depended upon to force internet connectivity established on the VPC
     * Add igw to this if its a public subnet
     */
    this.internetConnectivityEstablished = this._internetConnectivityEstablished;
  }
}
/**
 * Supports assigning IPv4 address to VPC
 */
class ipv4CidrAllocation implements IIpAddresses {
  constructor(private readonly cidrBlock: string, private readonly props?: { cidrBlockName: string}) {
  }

  /**
   * @returns CIDR block provided by the user to set IPv4
   */
  allocateVpcCidr(): VpcCidrOptions {
    return {
      ipv4CidrBlock: this.cidrBlock,
      cidrBlockName: this.props?.cidrBlockName,
    };
  }
}

/**
 * Supports Amazon Provided Ipv6 ranges
 */
class AmazonProvided implements IIpAddresses {
  /**
   * Represents an Amazon-provided IPv6 CIDR range for a VPC.
   *
   * This class implements the IIpAddresses interface and is used to allocate an Amazon-provided
   * IPv6 CIDR range for a VPC. When an instance of this class is used to allocate the VPC CIDR,
   * Amazon will automatically assign an IPv6 CIDR range from its pool of available addresses.
   */

  constructor(private readonly props: { cidrBlockName: string}) {}

  allocateVpcCidr(): VpcCidrOptions {
    return {
      amazonProvided: true,
      cidrBlockName: this.props.cidrBlockName,
    };
  }
}

/**
 * Represents an IPv4 address range managed by AWS IP Address Manager (IPAM).
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-ipam.html
 */
class IpamIpv6 implements IIpAddresses {
  constructor(private readonly props: IpamOptions) {
  }

  allocateVpcCidr(): VpcCidrOptions {
    return {
      ipv6NetmaskLength: this.props.netmaskLength,
      ipv6IpamPool: this.props.ipamPool,
      dependencies: this.props.ipamPool?.ipamCidrs.map(c => c as CfnResource),
      cidrBlockName: this.props.cidrBlockName,
    };
  }
}

/**
 * Represents an IPv4 address range managed by AWS IP Address Manager (IPAM).
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-ipam.html
 */
class IpamIpv4 implements IIpAddresses {
  constructor(private readonly props: IpamOptions) {
  }
  allocateVpcCidr(): VpcCidrOptions {
    return {
      ipv4NetmaskLength: this.props.netmaskLength,
      ipv4IpamPool: this.props.ipamPool,
      cidrBlockName: this.props?.cidrBlockName,
      ipv4IpamProvisionedCidrs: this.props.ipamPool?.ipamIpv4Cidrs,
    };
  }
}

/**
 * Supports assigning IPv6 address to VPC in an address pool
 */
class Ipv6Pool implements IIpAddresses {
  constructor(private readonly props: Ipv6PoolSecondaryAddressProps) {
  }
  allocateVpcCidr(): VpcCidrOptions {
    return {
      ipv6CidrBlock: this.props.ipv6CidrBlock,
      ipv6PoolId: this.props.ipv6PoolId,
      cidrBlockName: this.props?.cidrBlockName,
    };
  }
}

/**
 * Interface to create L2 for VPC Cidr Block
 */
export interface IVPCCidrBlock {
  /**
   * Amazon Provided Ipv6
   */
  readonly amazonProvidedIpv6CidrBlock? : boolean;

  /**
   * The secondary IPv4 CIDR Block
   *
   * @default - no CIDR block provided
   */
  readonly cidrBlock?: string;

  /**
   * IPAM pool for IPv6 address type
   */
  readonly ipv6IpamPoolId ?: string;

  /**
   * IPAM pool for IPv4 address type
   */
  readonly ipv4IpamPoolId ?: string;

  /**
   * The IPv6 CIDR block from the specified IPv6 address pool.
   */
  readonly ipv6CidrBlock?: string;

  /**
   * The ID of the IPv6 address pool from which to allocate the IPv6 CIDR block.
   */
  readonly ipv6Pool?: string;
}

/**
 * Attributes for VPCCidrBlock used for defining a new CIDR Block
 * and also for importing an existing CIDR
 */
export interface VPCCidrBlockattributes {
  /**
   * Amazon Provided Ipv6
   *
   * @default false
   */
  readonly amazonProvidedIpv6CidrBlock? : boolean;

  /**
   * The secondary IPv4 CIDR Block
   *
   * @default - no CIDR block provided
   */
  readonly cidrBlock?: string;

  /**
   * The secondary IPv4 CIDR Block
   *
   * @default - no CIDR block provided
   */
  readonly cidrBlockName?: string;

  /**
   * Net mask length for IPv6 address type
   *
   * @default - no Net mask length configured for IPv6
   */
  readonly ipv6NetmaskLength?: number;

  /**
   * Net mask length for IPv4 address type
   *
   * @default - no Net mask length configured for IPv4
   */
  readonly ipv4NetmaskLength?: number;

  /**
   * IPAM pool for IPv6 address type
   *
   * @default - no IPAM pool Id provided for IPv6
   */
  readonly ipv6IpamPoolId ?: string;

  /**
   * IPAM pool for IPv4 address type
   *
   * @default - no IPAM pool Id provided for IPv4
   */
  readonly ipv4IpamPoolId ?: string;

  /**
   * IPv4 CIDR provisioned under pool
   * Required to check for overlapping CIDRs after provisioning
   * is complete under IPAM pool
   * @default - no IPAM IPv4 CIDR range is provisioned using IPAM
   */
  readonly ipv4IpamProvisionedCidrs?: string[];

  /**
   * The IPv6 CIDR block from the specified IPv6 address pool.
   *
   * @default - No IPv6 CIDR block associated with VPC.
   */
  readonly ipv6CidrBlock?: string;

  /**
   * The ID of the IPv6 address pool from which to allocate the IPv6 CIDR block.
   * Note: BYOIP Pool ID is different than IPAM Pool ID.
   *
   * @default - No BYOIP pool associated with VPC.
   */
  readonly ipv6Pool?: string;
}

/**
 * Interface VPCCidrBlock
 */
interface VPCCidrBlockProps extends VPCCidrBlockattributes {
  /**
   * The VPC Id for associating CIDR Block as a secondary address
   */
  readonly vpcId: string;
}

/**
 * Internal L2 to define a new VPC CIDR Block
 * @internal
 */
@propertyInjectable
class VPCCidrBlock extends Resource implements IVPCCidrBlock {
  /** Uniquely identifies this class. */
  public static readonly PROPERTY_INJECTION_ID: string = '@aws-cdk.aws-ec2-alpha.VPCCidrBlock';

  /**
   * Import an existing VPC CIDR Block
   */
  public static fromVPCCidrBlockattributes(scope: Construct, id: string, props: VPCCidrBlockattributes) : IVPCCidrBlock {
    class Import extends Resource implements IVPCCidrBlock {
      public readonly cidrBlock = props.cidrBlock;
      public readonly amazonProvidedIpv6CidrBlock ?: boolean = props.amazonProvidedIpv6CidrBlock;
      public readonly ipv6IpamPoolId ?: string = props.ipv6IpamPoolId;
      public readonly ipv4IpamPoolId ?: string = props.ipv4IpamPoolId;
      // BYOIP Pool Attributes
      public readonly ipv6Pool?: string = props.ipv6Pool;
      public readonly ipv6CidrBlock?: string = props.ipv6CidrBlock;
    }
    return new Import(scope, id);
  }

  public readonly resource: CfnVPCCidrBlock;

  public readonly cidrBlock?: string;

  public readonly amazonProvidedIpv6CidrBlock?: boolean;

  public readonly ipv6IpamPoolId?: string;

  public readonly ipv4IpamPoolId?: string;

  public readonly ipv6CidrBlock?: string;

  public readonly ipv6Pool?: string;

  constructor(scope: Construct, id: string, props: VPCCidrBlockProps) {
    super(scope, id);
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);
    this.resource = new CfnVPCCidrBlock(this, id, props);
    this.node.defaultChild = this.resource;
    this.cidrBlock = props.cidrBlock;
    this.ipv6IpamPoolId = props.ipv6IpamPoolId;
    this.ipv4IpamPoolId = props.ipv4IpamPoolId;
    this.amazonProvidedIpv6CidrBlock = props.amazonProvidedIpv6CidrBlock;
    // BYOIP Pool and CIDR Block
    this.ipv6CidrBlock = props.ipv6CidrBlock;
    this.ipv6Pool = props.ipv6Pool;
  }
}

// @internal First two Octet to verify RFC 1918
interface IPaddressConfig {
  octet1: number;
  octet2: number;
}

/**
 * Validates whether a secondary IPv4 address is within the same private IP address range as the primary IPv4 address.
 *
 * @param cidr1 The secondary IPv4 CIDR block to be validated.
 * @param cidr2 The primary IPv4 CIDR block to validate against.
 * @returns True if the secondary IPv4 CIDR block is within the same private IP address range as the primary IPv4 CIDR block, false otherwise.
 * @internal
 * The private IP address ranges are defined by RFC 1918 as 10.0.0.0/8, 172.16.0.0/12, and 192.168.0.0/16.
 */
function validateIpv4address(cidr1?: string, cidr2?: string): boolean {
  if (!cidr1 || !cidr2) {
    return false; // Handle cases where CIDR ranges are not provided
  }

  const octetsCidr1: number[] = cidr1.split('.').map(octet => parseInt(octet, 10));
  const octetsCidr2: number[] = cidr2.split('.').map(octet => parseInt(octet, 10));

  if (octetsCidr1.length !== 4 || octetsCidr2.length !== 4) {
    return false; // Handle invalid CIDR ranges
  }

  const ip1: IPaddressConfig = {
    octet1: octetsCidr1[0],
    octet2: octetsCidr1[1],
  };

  const ip2: IPaddressConfig = {
    octet1: octetsCidr2[0],
    octet2: octetsCidr2[1],
  };

  return (ip1.octet1 === 10 && ip2.octet1 === 10) ||
    (ip1.octet1 === 192 && ip1.octet2 === 168 && ip2.octet1 === 192 && ip2.octet2 === 168) ||
    (ip1.octet1 === 172 && ip1.octet2 === 16 && ip2.octet1 === 172 && ip2.octet2 === 16); // CIDR ranges belong to same private IP address ranges
}
