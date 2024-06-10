import { redisClient } from "@/lib/redisClient";

export const checkElementExists = async (
	key: string,
	value: string
): Promise<boolean> => {
	const script = `
  local value = ARGV[1]
  local list = redis.call('LRANGE', KEYS[1], 0, -1)
  for _, v in ipairs(list) do
      if v == value then
          return 1
      end
  end
  return 0
`;

	return Boolean(
		await redisClient.eval(script, {
			keys: [key],
			arguments: [value],
		})
	);
};
