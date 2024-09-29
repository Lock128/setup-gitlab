import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ecspatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as logs from 'aws-cdk-lib/aws-logs';

export class SetupGitlabStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a VPC with 9x subnets divided over 3 AZ's
    const vpc = new ec2.Vpc(this, 'GitlabVPC', {
      cidr: '172.33.0.0/16',
      natGateways: 1,
      maxAzs: 3,
      subnetConfiguration: [
        {
          cidrMask: 20,
          name: 'gitlab-public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 20,
          name: 'gitlab-application',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 20,
          name: 'gitlab-data',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // Create an ECS cluster
    const cluster = new ecs.Cluster(this, 'gitlab-service-cluster', {
      clusterName: 'gitlab-service-cluster',
      containerInsights: true,
      vpc: vpc,
    });


    const webSecurityGroup = new ec2.SecurityGroup(this, "gitlab-web-sg", {
      securityGroupName: `Gitlab-Web-app`,
      vpc,
    });

    webSecurityGroup.addIngressRule(
      webSecurityGroup,
      ec2.Port.tcp(2049), // Enable NFS service within security group
    );
    webSecurityGroup.addIngressRule(
      webSecurityGroup,
      ec2.Port.tcp(8001),
    );
    webSecurityGroup.addIngressRule(
      webSecurityGroup,
      ec2.Port.udp(8001)
    );

    const fileSystem = new efs.FileSystem(this, "EfsFileSystem", {
      vpc,
      securityGroup: webSecurityGroup
    });

    var accessPoint = new efs.AccessPoint(this, "volumeAccessPoint", {
      fileSystem: fileSystem,
      path: "/data",
      createAcl: {
        ownerGid: "0",
        ownerUid: "0",
        permissions: "755"
      },
      posixUser: {
        uid: "0",
        gid: "0"
      }
    });

    //https://hub.docker.com/r/gitlab/gitlab-ce
    const image = ecs.ContainerImage.fromRegistry('gitlab/gitlab-ce');


    const taskDefinition = new ecs.TaskDefinition(this, 'gitlab-web-task', {
      compatibility: ecs.Compatibility.FARGATE,
      memoryMiB: '16384',
      cpu: '8192',
      
    });
    fileSystem.grantRootAccess(taskDefinition.taskRole);

    const containerDefinition = {
      image: ecs.ContainerImage.fromRegistry('gitlab/gitlab-ce'),
      logging: new ecs.AwsLogDriver({
        streamPrefix: 'gitlab',
        logRetention: logs.RetentionDays.THREE_DAYS,
      }),
      
      workingDirectory: '/data',
      environment: {
        'GITLAB_URL_BASE': 'http://gitlab.lockhead.cloud',
        'GITLAB_HOME': '/data'
      },
      /*linuxParameters: new ecs.LinuxParameters(this, 'LinuxParameters', {
        sharedMemorySize: 1024,
      }),*/
    };

    const container = taskDefinition.addContainer('defaultContainer', containerDefinition);
    container.addPortMappings({
      containerPort: 3000,
      hostPort: 3000,
      protocol: ecs.Protocol.TCP,
    });
    container.addPortMappings({
      containerPort: 80,
      hostPort: 80,
      protocol: ecs.Protocol.TCP,
    });
    container.addPortMappings({
      containerPort: 9093,
      hostPort: 9093,
      protocol: ecs.Protocol.TCP,
    });
        /*
    - '$GITLAB_HOME/config:/etc/gitlab'
    - '$GITLAB_HOME/logs:/var/log/gitlab'
    - '$GITLAB_HOME/data:/var/opt/gitlab'
    */

    const efcVolumenConfigConfig: ecs.EfsVolumeConfiguration = {
      authorizationConfig: {
        accessPointId: accessPoint.accessPointId,
        iam: 'ENABLED',
      },
      fileSystemId: fileSystem.fileSystemId,
      transitEncryption: 'ENABLED',
      rootDirectory: '/config'
    };

    const configVolume = {
      name: "config",
      efcVolumenConfigConfig,

    };

    taskDefinition.addVolume(configVolume);

    container.addMountPoints({
      sourceVolume: configVolume.name,
      containerPath: "/etc/gitlab",
      readOnly: false,
    });

    const efcVolumenConfigLogs: ecs.EfsVolumeConfiguration = {
      authorizationConfig: {
        accessPointId: accessPoint.accessPointId,
        iam: 'ENABLED',
      },
      fileSystemId: fileSystem.fileSystemId,
      transitEncryption: 'ENABLED',
      rootDirectory: '/logs'
    };

    const logsVolume = {
      name: "logs",
      efcVolumenConfigLogs,

    };

    taskDefinition.addVolume(logsVolume);
    container.addMountPoints({
      sourceVolume: logsVolume.name,
      containerPath: "/var/log/gitlab",
      readOnly: false,
    });

    const efcVolumenConfigData: ecs.EfsVolumeConfiguration = {
      authorizationConfig: {
        accessPointId: accessPoint.accessPointId,
        iam: 'ENABLED',
      },
      fileSystemId: fileSystem.fileSystemId,
      transitEncryption: 'ENABLED',
      rootDirectory: '/data'
    };

    const dataVolume = {
      name: "data",
      efcVolumenConfigData,

    };

    taskDefinition.addVolume(dataVolume);

    container.addMountPoints({
      sourceVolume: dataVolume.name,
      containerPath: "/var/opt/gitlab",
      readOnly: false,
    });


    // Create higher level construct containing the Fargate service with a load balancer
    const service = new ecspatterns.ApplicationLoadBalancedFargateService(this, 'gitlab-service', {
      cluster,
      circuitBreaker: {
        
        rollback: true,
      },
      memoryLimitMiB: 16384, // Supported configurations: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs_patterns.ApplicationMultipleTargetGroupsFargateService.html#memorylimitmib
      cpu: 8192,
      desiredCount: 1,
      taskDefinition: taskDefinition,
      securityGroups: [webSecurityGroup],
      healthCheckGracePeriod: cdk.Duration.minutes(30)
    });
  }

}
