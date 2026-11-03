import { z } from 'zod';

/**
 * Adapter options for the cobas e 411. Values must match what is configured on
 * the analyzer under [Utility]-[System]-[Host Communication Setting] [e411 HIM B-4 to B-6].
 */
export const E411Options = z
  .object({
    /** Record dialect selected on the analyzer [e411 HIM B-6]. */
    protocolType: z.enum(['cobas', 'elecsys']).default('cobas'),
    /**
     * Host test codes whose R-4 value is "<qualitative>^<cut-off index>" (1 / 0 / -1)
     * rather than "<value>^<message value>" [e411 HIM E-16]. The record alone cannot tell
     * the two apart, so this must come from the lab's test configuration.
     */
    qualitativeTestCodes: z.array(z.string().min(1)).default([]),
    /** Name used as sender in host-originated headers (cobas® type: alphanumeric and "-") [e411 HIM E-6]. */
    hostName: z.string().regex(/^[A-Za-z0-9-]{1,30}$/).default('host'),
  })
  .strict();
export type E411Options = z.infer<typeof E411Options>;

export const ADAPTER_NAME = 'cobas-e411-astm';
export const ADAPTER_VERSION = '0.1.0';

/** Max tests in one test-selection O record [e411 HIM E-12]. */
export const MAX_TESTS_PER_ORDER = 18;
