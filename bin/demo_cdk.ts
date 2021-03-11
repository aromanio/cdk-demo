#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { DemoCdkStack } from '../lib/demo_cdk-stack';

const app = new cdk.App();
new DemoCdkStack(app, 'DemoCdkStack', {
    antiCaptchaKey: '5bbd8a9f32f0ae05595376dcb4e00ba1',
    personalEmailAddress: 'rmoonikz@gmail.com',
    emailAddress: 'istoric@rar.pfh.ro',
    rootDomain: 'pfh.ro',
    subdomain: 'rar.pfh.ro',
    env: {
        account: '049030324968',
        region: 'eu-west-1',
    },
});
