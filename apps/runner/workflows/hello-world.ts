export async function helloWorldWorkflow(): Promise<{ message: 'Hello, world!' }> {
  'use workflow';

  return helloWorldStep();
}

async function helloWorldStep(): Promise<{ message: 'Hello, world!' }> {
  'use step';

  return { message: 'Hello, world!' };
}
