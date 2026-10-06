import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as iam from "aws-cdk-lib/aws-iam";

export class HighDemandPlatformStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with public subnets in 2 Availability Zones
    const vpc = new ec2.Vpc(this, "AppVpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // Security Group for ALB
    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc,
      description: "Security group for Application Load Balancer",
      allowAllOutbound: true,
    });

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow HTTP traffic",
    );

    // Security Group for EC2
    const ec2SecurityGroup = new ec2.SecurityGroup(this, "Ec2SecurityGroup", {
      vpc,
      description: "Security group for application instances",
      allowAllOutbound: true,
    });

    // Only allow HTTP traffic from the ALB
    ec2SecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(80),
      "Allow HTTP traffic from ALB only",
    );

    // IAM role for EC2
    const instanceRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Minimal IAM role for application instances",
    });

    // Amazon Linux 2023
    const machineImage = ec2.MachineImage.latestAmazonLinux2023();

    // Auto Scaling Group
    const asg = new autoscaling.AutoScalingGroup(this, "AppAsg", {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },

      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO,
      ),

      machineImage,
      minCapacity: 2,
      desiredCapacity: 2,
      maxCapacity: 6,

      securityGroup: ec2SecurityGroup,
      role: instanceRole,

      associatePublicIpAddress: true,

      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: autoscaling.BlockDeviceVolume.ebs(8, {
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],

      healthCheck: autoscaling.HealthCheck.elb({
        grace: cdk.Duration.minutes(5),
      }),

      userData: ec2.UserData.forLinux(),
    });

    // Install nginx and create a simple application
    asg.addUserData(
      `#!/bin/bash`,
      `dnf update -y`,
      `dnf install -y nginx`,
      `systemctl enable nginx`,
      `systemctl start nginx`,
      `INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)`,
      `AZ=$(curl -s http://169.254.169.254/latest/meta-data/placement/availability-zone)`,
      `echo "<html><body><h1>High Demand Platform</h1><p>Instance: $INSTANCE_ID</p><p>Availability Zone: $AZ</p></body></html>" > /usr/share/nginx/html/index.html`,
    );

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, "AppAlb", {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
    });

    // Listener
    const listener = alb.addListener("HttpListener", {
      port: 80,
      open: false,
    });

    // Register ASG as target
    listener.addTargets("AppTargets", {
      port: 80,
      targets: [asg],
      healthCheck: {
        path: "/",
        port: "80",
        healthyHttpCodes: "200",
      },
    });

    // CPU-based Auto Scaling
    asg.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 60,
      cooldown: cdk.Duration.minutes(1),
    });

    // Outputs
    new cdk.CfnOutput(this, "LoadBalancerUrl", {
      value: `http://${alb.loadBalancerDnsName}`,
    });

    new cdk.CfnOutput(this, "VpcId", {
      value: vpc.vpcId,
    });

    new cdk.CfnOutput(this, "AutoScalingGroupName", {
      value: asg.autoScalingGroupName,
    });
  }
}
