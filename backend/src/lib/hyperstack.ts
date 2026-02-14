/**
 * Hyperstack API client.
 * Quirks: hibernate/restore use GET (not POST), auth is `api_key` header.
 */

export interface HyperstackClient {
  getVmStatus(vmId: string): Promise<HyperstackVmStatus>;
  hibernateVm(vmId: string): Promise<void>;
  restoreVm(vmId: string): Promise<void>;
}

export interface HyperstackVmStatus {
  id: string;
  name: string;
  status: string; // 'ACTIVE' | 'HIBERNATED' | 'HIBERNATING' | 'RESTORING' | etc.
}

export function createHyperstackClient(apiKey: string): HyperstackClient {
  const baseUrl = 'https://infrahub-api.nexgencloud.com/v1';

  async function request(method: string, path: string): Promise<unknown> {
    const resp = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'api_key': apiKey,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Hyperstack API error ${resp.status}: ${body}`);
    }
    return resp.json();
  }

  return {
    async getVmStatus(vmId: string): Promise<HyperstackVmStatus> {
      const data = (await request('GET', `/core/virtual-machines/${vmId}`)) as {
        virtual_machine: HyperstackVmStatus;
      };
      return data.virtual_machine;
    },

    async hibernateVm(vmId: string): Promise<void> {
      await request('GET', `/core/virtual-machines/${vmId}/hibernate`);
    },

    async restoreVm(vmId: string): Promise<void> {
      await request('GET', `/core/virtual-machines/${vmId}/restore`);
    },
  };
}
