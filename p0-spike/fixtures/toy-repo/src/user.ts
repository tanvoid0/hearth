export interface User {
  id: string;
  firstName: string;
  lastName: string;
}

export function fullName(user: User): string {
  return `${user.firstName} ${user.lastName}`;
}
