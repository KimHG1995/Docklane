export interface ApplicationRecord {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentTargetRecord {
  id: string;
  applicationId: string;
  clusterId: string;
  environment: string;
  dockerServiceId: string;
  serviceName: string;
  routingMode: 'INGRESS';
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseRecord {
  id: string;
  applicationId: string;
  version: string;
  imageRepository: string;
  imageTag: string | null;
  imageDigest: string;
  gitCommit: string | null;
  buildNumber: string | null;
  createdBy: string;
  createdAt: string;
}
